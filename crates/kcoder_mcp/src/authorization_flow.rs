//! Target-owned authorization orchestration; browser-facing callers receive no credentials.

use crate::authorization::AuthorizationServerMetadata;
use crate::authorization_registration::{RegisteredClient, register_client};
use crate::authorization_session::AuthorizationSession;
use crate::authorization_store::{CredentialBinding, OAuthTokenStore};
use crate::authorization_tokens::exchange_authorization_code;
use anyhow::{Result, bail};
use reqwest::Url;

/// Retained by the target runtime until callback, cancellation, or owner disconnect.
pub struct PendingAuthorization {
    session: AuthorizationSession,
    client: RegisteredClient,
    binding: CredentialBinding,
    credential_generation: String,
    connection: Option<(Url, String, AuthorizationServerMetadata)>,
}

impl std::fmt::Debug for PendingAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingAuthorization")
            .finish_non_exhaustive()
    }
}

impl PendingAuthorization {
    /// Call only after the user requests authorization. Discovery alone must not register a client.
    pub async fn begin(
        store: &OAuthTokenStore,
        metadata: &AuthorizationServerMetadata,
        resource: &Url,
        redirect: &Url,
        scopes: &[String],
        manual_client: Option<RegisteredClient>,
    ) -> Result<Self> {
        let mut lease = store.acquire_registration(metadata, redirect).await?;
        let client = match manual_client {
            Some(client) => {
                lease.save(&client)?;
                client
            }
            None => match lease.load()? {
                Some(client) => client,
                None => {
                    let client = register_client(metadata, redirect).await?;
                    lease.save(&client)?;
                    client
                }
            },
        };
        client.authentication()?;
        let session =
            AuthorizationSession::new(metadata, client.client_id(), resource, redirect, scopes)?;
        let binding = CredentialBinding {
            resource: resource.clone(),
            issuer: client.issuer().clone(),
            client_id: client.client_id().into(),
            token_endpoint: Url::parse(&metadata.token_endpoint)
                .map_err(|_| anyhow::anyhow!("Invalid OAuth token endpoint"))?,
        };
        drop(lease);
        let credential_generation = store
            .acquire(binding.clone())
            .await?
            .authorization_generation()?;
        Ok(Self {
            session,
            client,
            binding,
            credential_generation,
            connection: None,
        })
    }

    /// Bind the flow to a configured endpoint and persist its association on completion.
    pub async fn begin_for_endpoint(
        store: &OAuthTokenStore,
        endpoint: &Url,
        metadata: &AuthorizationServerMetadata,
        resource: &Url,
        redirect: &Url,
        scopes: &[String],
        manual_client: Option<RegisteredClient>,
    ) -> Result<Self> {
        if !crate::authorization::resource_covers_endpoint(resource, endpoint) {
            bail!("OAuth resource does not cover the configured MCP endpoint");
        }
        let mut association = store.acquire_connection(endpoint).await?;
        let mut flow =
            Self::begin(store, metadata, resource, redirect, scopes, manual_client).await?;
        let generation = association.invalidate_pending()?;
        flow.connection = Some((endpoint.clone(), generation, metadata.clone()));
        Ok(flow)
    }

    pub fn authorization_url(&self) -> &Url {
        self.session.authorization_url()
    }

    pub fn cancel(&mut self) {
        self.session.cancel();
    }

    /// The caller must additionally enforce connection ownership before forwarding a callback.
    pub async fn complete(&mut self, store: &OAuthTokenStore, callback: &Url) -> Result<()> {
        let mut address = callback.clone();
        address.set_query(None);
        if &address != self.client.redirect_uri() {
            bail!("OAuth callback address does not match");
        }
        let mut parameters = std::collections::HashMap::new();
        for (name, value) in callback.query_pairs() {
            if parameters
                .insert(name.into_owned(), value.into_owned())
                .is_some()
            {
                bail!("OAuth callback contains duplicate parameters");
            }
        }
        let state = parameters
            .get("state")
            .ok_or_else(|| anyhow::anyhow!("OAuth callback omitted state"))?;
        let issuer = parameters.get("iss").map(String::as_str);
        if parameters.contains_key("error") {
            if parameters.contains_key("code") {
                bail!("OAuth callback contains both code and error");
            }
            self.session.reject_callback(state, issuer)?;
            bail!("OAuth authorization was declined by the authorization server");
        }
        let code = parameters
            .get("code")
            .ok_or_else(|| anyhow::anyhow!("OAuth callback omitted authorization code"))?;
        let mut association = if let Some((endpoint, generation, _)) = &self.connection {
            let association = store.acquire_connection(endpoint).await?;
            association.verify_generation(generation)?;
            Some(association)
        } else {
            None
        };
        // Acquire the credential lease before consuming the one-use grant.
        let mut lease = store.acquire(self.binding.clone()).await?;
        if lease.authorization_generation()? != self.credential_generation {
            self.session.cancel();
            bail!("OAuth authorization was logged out through a shared resource");
        }
        let grant = self.session.complete_callback(state, code, issuer)?;
        let tokens = exchange_authorization_code(grant, self.client.authentication()?).await?;
        lease.save(&tokens)?;
        if let (Some(association), Some((_, _, metadata))) = (&mut association, &self.connection) {
            association.save(&crate::authorization_index::ConnectionAuthorization {
                binding: self.binding.clone(),
                metadata: metadata.clone(),
                redirect_uri: self.client.redirect_uri().clone(),
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorization_registration::RegistrationMethod;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn callback_exchanges_once_persists_and_reuses_registration() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": base, "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"), "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"]
        }))
        .unwrap();
        let redirect = Url::parse("http://127.0.0.1:34567/callback").unwrap();
        let resource = Url::parse("https://mcp.example.test/mcp").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(directory.path()).unwrap();
        let client = RegisteredClient::manual(
            &metadata,
            "registered-client".into(),
            None,
            RegistrationMethod::Public,
            &redirect,
        )
        .unwrap();
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
        let mut callback = redirect.clone();
        callback
            .query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("code", "private-code");
        let mut duplicate = callback.clone();
        duplicate
            .query_pairs_mut()
            .append_pair("code", "other-code");
        assert!(flow.complete(&store, &duplicate).await.is_err());
        let mut wrong = callback.clone();
        wrong.set_path("/wrong-callback");
        assert!(flow.complete(&store, &wrong).await.is_err());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        let form: std::collections::HashMap<String, String> =
                            serde_urlencoded::from_bytes(&bytes[end + 4..]).unwrap();
                        assert_eq!(form["code"], "private-code");
                        assert_eq!(form["client_id"], "registered-client");
                        assert_eq!(form["resource"], "https://mcp.example.test/mcp");
                        assert_eq!(form["code_verifier"].len(), 43);
                        break;
                    }
                }
            }
            let body = r#"{"access_token":"stored-access","refresh_token":"stored-refresh","token_type":"Bearer","expires_in":3600}"#;
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            ).as_bytes()).await.unwrap();
        });
        flow.complete(&store, &callback).await.unwrap();
        server.await.unwrap();
        assert!(flow.complete(&store, &callback).await.is_err());
        let reopened = OAuthTokenStore::open(directory.path()).unwrap();
        let tokens = reopened
            .acquire(flow.binding.clone())
            .await
            .unwrap()
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(tokens.access_token(), "stored-access");
        assert_eq!(tokens.scope(), Some("read"));
        let saved_connection = reopened
            .acquire_connection(&resource)
            .await
            .unwrap()
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(saved_connection.binding.client_id, "registered-client");
        assert_eq!(saved_connection.redirect_uri, redirect);

        let mut resumed =
            PendingAuthorization::begin(&reopened, &metadata, &resource, &redirect, &[], None)
                .await
                .unwrap();
        assert_eq!(resumed.client.client_id(), "registered-client");
        let resumed_state = resumed
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        let mut denied = redirect.clone();
        denied
            .query_pairs_mut()
            .append_pair("state", &resumed_state)
            .append_pair("error", "private-error-description");
        let error = resumed.complete(&reopened, &denied).await.unwrap_err();
        assert!(error.to_string().contains("declined"));
        assert!(!format!("{error:?}").contains("private-error"));
        assert!(
            resumed
                .session
                .complete_callback(&resumed_state, "code", None)
                .is_err()
        );
        let mut alias_endpoint = resource.clone();
        alias_endpoint.set_query(Some("alias=other"));
        let mut alias_pending = PendingAuthorization::begin_for_endpoint(
            &reopened,
            &alias_endpoint,
            &metadata,
            &resource,
            &redirect,
            &[],
            None,
        )
        .await
        .unwrap();
        let alias_state = alias_pending
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        let mut alias_callback = redirect.clone();
        alias_callback
            .query_pairs_mut()
            .append_pair("state", &alias_state)
            .append_pair("code", "unused-alias-code");
        reopened.logout_endpoint(&resource).await.unwrap();
        let alias_error = alias_pending
            .complete(&reopened, &alias_callback)
            .await
            .unwrap_err();
        assert!(
            alias_error
                .to_string()
                .contains("logged out through a shared resource")
        );
        assert!(
            reopened
                .acquire_connection(&resource)
                .await
                .unwrap()
                .load()
                .unwrap()
                .is_none()
        );
        assert!(
            reopened
                .acquire(flow.binding.clone())
                .await
                .unwrap()
                .load()
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn logout_invalidates_pending_callbacks_before_any_token_exchange() {
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://auth.example.test",
            "authorization_endpoint": "https://auth.example.test/authorize",
            "token_endpoint": "https://auth.example.test/token",
            "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"]
        }))
        .unwrap();
        let resource = Url::parse("https://mcp.example.test/mcp").unwrap();
        let redirect = Url::parse("http://127.0.0.1:34567/callback").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(directory.path()).unwrap();
        let client = RegisteredClient::manual(
            &metadata,
            "client".into(),
            None,
            RegistrationMethod::Public,
            &redirect,
        )
        .unwrap();
        let mut old = PendingAuthorization::begin_for_endpoint(
            &store,
            &resource,
            &metadata,
            &resource,
            &redirect,
            &[],
            Some(client),
        )
        .await
        .unwrap();
        let mut callback = redirect.clone();
        let state = old
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        callback
            .query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("code", "unused-code");
        let reopened = OAuthTokenStore::open(directory.path()).unwrap();
        reopened.logout_endpoint(&resource).await.unwrap();
        let error = old.complete(&store, &callback).await.unwrap_err();
        assert!(error.to_string().contains("superseded or logged out"));
        assert!(
            store
                .acquire(old.binding.clone())
                .await
                .unwrap()
                .load()
                .unwrap()
                .is_none()
        );
        let newer = PendingAuthorization::begin_for_endpoint(
            &reopened,
            &resource,
            &metadata,
            &resource,
            &redirect,
            &[],
            None,
        )
        .await
        .unwrap();
        assert_ne!(old.authorization_url(), newer.authorization_url());
        assert!(
            old.complete(&store, &callback)
                .await
                .unwrap_err()
                .to_string()
                .contains("superseded")
        );
    }
}

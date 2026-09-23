//! Endpoint-to-credential associations, stored separately from secret credential records.

use crate::authorization::{
    AuthorizationServerMetadata, resource_covers_endpoint, validate_endpoint,
};
use crate::authorization_store::{CredentialBinding, OAuthTokenStore, acquire_lock, read_record};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs::File, sync::Arc};

pub struct ConnectionAuthorization {
    pub binding: CredentialBinding,
    pub metadata: AuthorizationServerMetadata,
    pub redirect_uri: Url,
}

#[derive(Serialize, Deserialize)]
struct StoredConnection {
    version: u32,
    endpoint: String,
    resource: String,
    client_id: String,
    redirect_uri: String,
    metadata: AuthorizationServerMetadata,
}

pub struct OAuthConnectionLease {
    directory: Arc<PrivateDirectory>,
    lock: File,
    name: String,
    endpoint: Url,
}

impl Drop for OAuthConnectionLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock);
    }
}

impl OAuthTokenStore {
    /// Lock order is connection, registration, then token; release registration before token.
    pub async fn acquire_connection(&self, endpoint: &Url) -> Result<OAuthConnectionLease> {
        validate_endpoint(endpoint)?;
        let name = format!(
            "connection-{:x}",
            Sha256::digest(endpoint.as_str().as_bytes())
        );
        let directory = Arc::clone(&self.directory);
        let endpoint = endpoint.clone();
        tokio::task::spawn_blocking(move || {
            let lock = acquire_lock(&directory, &name)?;
            Ok(OAuthConnectionLease {
                directory,
                lock,
                name: format!("{name}.json"),
                endpoint,
            })
        })
        .await
        .context("OAuth connection lease worker failed")?
    }
}

impl OAuthTokenStore {
    /// Include shared credential availability so logout through an alias invalidates every consumer.
    pub async fn connection_cache_revision(&self, endpoint: &Url) -> Result<String> {
        let association = self.acquire_connection(endpoint).await?;
        let mut digest = Sha256::new();
        digest.update(association.revision()?.as_bytes());
        if let Some(saved) = association.load()? {
            let lease = self.acquire(saved.binding).await?;
            match lease.load()? {
                Some(tokens) => {
                    digest.update(b"authorized");
                    digest.update([u8::from(
                        tokens
                            .expires_at()
                            .is_some_and(|expiry| expiry <= std::time::Instant::now()),
                    )]);
                    digest.update(tokens.scope().unwrap_or_default().as_bytes());
                }
                None => digest.update(b"credentials-absent"),
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    pub async fn logout_endpoint(&self, endpoint: &Url) -> Result<()> {
        let mut connection = self.acquire_connection(endpoint).await?;
        let saved = connection.load()?;
        connection.invalidate_pending()?;
        if let Some(saved) = saved {
            let mut credentials = self.acquire(saved.binding).await?;
            credentials.invalidate_authorization()?;
            credentials.remove()?;
        }
        connection.remove()
    }
}

impl OAuthConnectionLease {
    /// Opaque cache revision; neither tokens nor registration secrets are read.
    pub fn revision(&self) -> Result<String> {
        let mut digest = Sha256::new();
        for name in [&self.name, &format!("{}.generation", self.name)] {
            if let Some(bytes) = read_record(&self.directory, name)? {
                digest.update((bytes.len() as u64).to_le_bytes());
                digest.update(bytes.as_slice());
            } else {
                digest.update(0u64.to_le_bytes());
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    /// Persist invalidation even when no completed authorization exists.
    pub(crate) fn invalidate_pending(&mut self) -> Result<String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("OAuth random source is unavailable"))?;
        let generation = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.directory.atomic_replace(
            OsStr::new(&format!("{}.generation", self.name)),
            generation.as_bytes(),
        )?;
        Ok(generation)
    }

    pub(crate) fn verify_generation(&self, expected: &str) -> Result<()> {
        let current = read_record(&self.directory, &format!("{}.generation", self.name))?;
        if current.as_deref().map(Vec::as_slice) != Some(expected.as_bytes()) {
            bail!("OAuth authorization was superseded or logged out");
        }
        Ok(())
    }

    pub fn load(&self) -> Result<Option<ConnectionAuthorization>> {
        let Some(bytes) = read_record(&self.directory, &self.name)? else {
            return Ok(None);
        };
        let record: StoredConnection = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth connection association"))?;
        if record.version != 1 || record.endpoint != self.endpoint.as_str() {
            bail!("OAuth connection association does not match this endpoint");
        }
        let parse = |value: &str| {
            Url::parse(value).map_err(|_| anyhow::anyhow!("Invalid OAuth connection URL"))
        };
        let connection = ConnectionAuthorization {
            binding: CredentialBinding {
                resource: parse(&record.resource)?,
                issuer: parse(&record.metadata.issuer)?,
                client_id: record.client_id,
                token_endpoint: parse(&record.metadata.token_endpoint)?,
            },
            redirect_uri: parse(&record.redirect_uri)?,
            metadata: record.metadata,
        };
        self.validate(&connection)?;
        Ok(Some(connection))
    }

    pub fn save(&mut self, connection: &ConnectionAuthorization) -> Result<()> {
        self.validate(connection)?;
        let record = StoredConnection {
            version: 1,
            endpoint: self.endpoint.as_str().into(),
            resource: connection.binding.resource.as_str().into(),
            client_id: connection.binding.client_id.clone(),
            redirect_uri: connection.redirect_uri.as_str().into(),
            metadata: connection.metadata.clone(),
        };
        let bytes = serde_json::to_vec(&record)
            .map_err(|_| anyhow::anyhow!("Cannot encode OAuth connection association"))?;
        if bytes.len() > 1024 * 1024 {
            bail!("OAuth connection association exceeds the size limit");
        }
        self.directory
            .atomic_replace(OsStr::new(&self.name), &bytes)
    }

    pub fn remove(&mut self) -> Result<()> {
        match self.directory.remove_regular_file(OsStr::new(&self.name)) {
            Ok(()) => Ok(()),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn validate(&self, connection: &ConnectionAuthorization) -> Result<()> {
        let binding = &connection.binding;
        for url in [
            &binding.resource,
            &binding.issuer,
            &binding.token_endpoint,
            &connection.redirect_uri,
        ] {
            validate_endpoint(url)?;
        }
        if !resource_covers_endpoint(&binding.resource, &self.endpoint)
            || binding.client_id.is_empty()
            || binding.issuer.query().is_some()
            || connection.redirect_uri.query().is_some()
            || Url::parse(&connection.metadata.issuer).ok().as_ref() != Some(&binding.issuer)
            || Url::parse(&connection.metadata.token_endpoint)
                .ok()
                .as_ref()
                != Some(&binding.token_endpoint)
            || (binding.issuer.scheme() == "https" && binding.token_endpoint.scheme() != "https")
        {
            bail!("OAuth connection association has inconsistent resource or client bindings");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> ConnectionAuthorization {
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://auth.example.test", "authorization_endpoint": "https://auth.example.test/authorize",
            "token_endpoint": "https://auth.example.test/token", "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]
        })).unwrap();
        ConnectionAuthorization {
            binding: CredentialBinding {
                resource: Url::parse("https://mcp.example.test").unwrap(),
                issuer: Url::parse(&metadata.issuer).unwrap(),
                client_id: "registered-client".into(),
                token_endpoint: Url::parse(&metadata.token_endpoint).unwrap(),
            },
            metadata,
            redirect_uri: Url::parse("http://127.0.0.1:34567/callback").unwrap(),
        }
    }

    #[tokio::test]
    async fn association_restores_after_reopen_and_isolates_endpoint_queries() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = Url::parse("https://mcp.example.test/mcp?tenant=one").unwrap();
        {
            let store = OAuthTokenStore::open(directory.path()).unwrap();
            let mut lease = store.acquire_connection(&endpoint).await.unwrap();
            assert!(lease.load().unwrap().is_none());
            lease.save(&connection()).unwrap();
        }
        let store = OAuthTokenStore::open(directory.path()).unwrap();
        let mut lease = store.acquire_connection(&endpoint).await.unwrap();
        let restored = lease.load().unwrap().unwrap();
        assert_eq!(restored.binding.client_id, "registered-client");
        assert_eq!(restored.redirect_uri, connection().redirect_uri);
        let other = Url::parse("https://mcp.example.test/mcp?tenant=two").unwrap();
        assert!(
            store
                .acquire_connection(&other)
                .await
                .unwrap()
                .load()
                .unwrap()
                .is_none()
        );
        lease.remove().unwrap();
        assert!(lease.load().unwrap().is_none());
    }

    #[tokio::test]
    async fn cache_revision_tracks_authorization_completion_invalidation_and_logout() {
        let directory = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(directory.path()).unwrap();
        let endpoint = Url::parse("https://mcp.example.test/mcp").unwrap();
        let mut lease = store.acquire_connection(&endpoint).await.unwrap();
        let empty = lease.revision().unwrap();
        lease.save(&connection()).unwrap();
        let authorized = lease.revision().unwrap();
        assert_ne!(empty, authorized);
        assert_eq!(authorized, lease.revision().unwrap());
        lease.invalidate_pending().unwrap();
        let pending = lease.revision().unwrap();
        assert_ne!(authorized, pending);
        lease.remove().unwrap();
        assert_ne!(pending, lease.revision().unwrap());
        drop(lease);
        let reopened = OAuthTokenStore::open(directory.path()).unwrap();
        let first = store
            .acquire_connection(&endpoint)
            .await
            .unwrap()
            .revision()
            .unwrap();
        let second = reopened
            .acquire_connection(&endpoint)
            .await
            .unwrap()
            .revision()
            .unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn logout_through_one_alias_invalidates_another_alias_cache_revision() {
        let directory = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(directory.path()).unwrap();
        let first = Url::parse("https://mcp.example.test/mcp?alias=first").unwrap();
        let second = Url::parse("https://mcp.example.test/mcp?alias=second").unwrap();
        let connection = connection();
        for endpoint in [&first, &second] {
            store
                .acquire_connection(endpoint)
                .await
                .unwrap()
                .save(&connection)
                .unwrap();
        }
        let binding = &connection.binding;
        let tokens = crate::authorization_tokens::OAuthTokens::from_store_bytes(
            &serde_json::to_vec(&serde_json::json!({
                "version": 2, "refresh_pending": false, "resource": binding.resource.as_str(),
                "issuer": binding.issuer.as_str(), "client_id": binding.client_id,
                "token_endpoint": binding.token_endpoint.as_str(),
                "access_token": "shared-token", "refresh_token": null, "expires_at_ms": null, "scope": "read"
            })).unwrap(), &binding.resource, &binding.issuer, &binding.client_id, &binding.token_endpoint,
        ).unwrap();
        store
            .acquire(binding.clone())
            .await
            .unwrap()
            .save(&tokens)
            .unwrap();
        let before = store.connection_cache_revision(&second).await.unwrap();
        let metadata_before = store
            .acquire_connection(&second)
            .await
            .unwrap()
            .revision()
            .unwrap();
        assert_eq!(
            before,
            store.connection_cache_revision(&second).await.unwrap()
        );
        store.logout_endpoint(&first).await.unwrap();
        assert_eq!(
            metadata_before,
            store
                .acquire_connection(&second)
                .await
                .unwrap()
                .revision()
                .unwrap()
        );
        assert_ne!(
            before,
            store.connection_cache_revision(&second).await.unwrap()
        );
    }

    #[tokio::test]
    async fn association_rejects_resource_substitution_and_corrupt_records() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = Url::parse("https://mcp.example.test/mcp").unwrap();
        let store = OAuthTokenStore::open(directory.path()).unwrap();
        let mut lease = store.acquire_connection(&endpoint).await.unwrap();
        let mut invalid = connection();
        invalid.binding.resource = Url::parse("https://other.example.test").unwrap();
        assert!(lease.save(&invalid).is_err());
        lease.save(&connection()).unwrap();
        let path = directory.path().join(&lease.name);
        let mut document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        document["endpoint"] = serde_json::json!("https://other.example.test");
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(lease.load().is_err());
        std::fs::write(&path, br#"{"version":"private-corrupt-value"}"#).unwrap();
        let error = lease.load().err().unwrap();
        assert!(!format!("{error:?}").contains("private-corrupt-value"));
    }
}

//! Read-only observations of an existing, native-profile-owned OAuth store.
use super::*;
use crate::{
    authorization_registration::RegisteredClient,
    authorization_tokens::{OAuthTokens, RefreshRecoveryRequired},
};
use anyhow::ensure;
use kcoder_config::{PortableLeaseIdentity, PrivateLeaseMode, VerifiedPrivateLease};
use serde::Deserialize;
use std::{
    io::Read,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const STORE: &str = "mcp-oauth";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthObservationState {
    Authorized,
    NotAuthorized,
    Expired,
    ReauthorizationRequired,
    Unknown,
}

/// Public identity is the actual stored resource/issuer/client association, not
/// a server display name or a guessed third-party human account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthPublicMetadata {
    pub binding_id: String,
    pub authorization_revision: String,
    pub state: OAuthObservationState,
    pub reason_code: &'static str,
    pub expires_at_ms: Option<u64>,
}

pub struct ExistingOAuthObservationStore {
    profile: PrivateDirectory,
    directory: Arc<PrivateDirectory>,
    directory_identity: String,
    account: Option<String>,
}

impl ExistingOAuthObservationStore {
    /// The caller supplies the actual selected-target profile handle and must
    /// separately verify its native identity before and after using this reader.
    pub fn open_existing(profile: &PrivateDirectory) -> Result<Option<Self>> {
        Self::open_existing_for_account(profile, None)
    }

    pub fn open_existing_for_account(
        profile: &PrivateDirectory,
        account: Option<&str>,
    ) -> Result<Option<Self>> {
        crate::authorization_store::validate_account(account)?;
        profile.verify_private_directory()?;
        let entry = match profile.open_entry_handle(OsStr::new(STORE)) {
            Ok(entry) => entry,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error).context("MCP_OAUTH_OBSERVATION_UNAVAILABLE"),
        };
        let directory = entry.open_child_directory()?;
        directory.verify_private_directory()?;
        let directory_identity = directory.directory_identity()?;
        Ok(Some(Self {
            profile: profile.duplicate_handle()?,
            directory: Arc::new(directory),
            directory_identity,
            account: account.map(str::to_owned),
        }))
    }

    fn verify(&self) -> Result<()> {
        self.profile.verify_private_directory()?;
        self.directory.verify_private_directory()?;
        let current = self
            .profile
            .open_entry_handle(OsStr::new(STORE))?
            .open_child_directory()?;
        current.verify_private_directory()?;
        ensure!(
            current.directory_identity()? == self.directory_identity
                && self.directory.directory_identity()? == self.directory_identity,
            "MCP_OAUTH_OBSERVATION_STORE_CHANGED"
        );
        Ok(())
    }

    /// Does no network, refresh, initialization, chmod, lock creation or repair.
    /// Existing metadata/locks missing or unsafe cannot establish authorization.
    pub fn observe_connection(&self, endpoint: &Url) -> Result<Option<OAuthPublicMetadata>> {
        validate_endpoint(endpoint)?;
        self.verify()?;
        let connection_key = format!(
            "connection-{}",
            crate::authorization_store::scoped_key(
                self.account.as_deref(),
                endpoint.as_str().as_bytes()
            )
        );
        let connection_name = format!("{connection_key}.json");
        let Some((_initial, _)) = read_existing(&self.directory, &connection_name)? else {
            return Ok(None);
        };
        let connection_lock = existing_lock(&self.directory, &format!("{connection_key}.lock"))?;
        let connection = OAuthConnectionLease {
            directory: self.directory.clone(),
            lock: connection_lock.file().try_clone()?,
            name: connection_name,
            endpoint: endpoint.clone(),
            account: self.account.clone(),
        };
        // Reuse the authoritative association parser/resource/issuer/client checks.
        let saved = connection
            .load()
            .map_err(|_| anyhow::anyhow!("MCP_OAUTH_ASSOCIATION_INVALID"))?
            .context("MCP_OAUTH_ASSOCIATION_UNAVAILABLE")?;
        let mut binding_identity = serde_json::json!([
            "native-oauth-account-v1",
            self.directory_identity,
            saved.binding.resource.as_str(),
            saved.binding.issuer.as_str(),
            saved.binding.client_id
        ]);
        if let Some(account) = &self.account {
            binding_identity
                .as_array_mut()
                .expect("binding identity is an array")
                .push(serde_json::json!(["oauth_account", account]));
        }
        let binding_id = metadata_digest(&binding_identity)?;
        let (_, association_identity) = read_existing(&self.directory, &connection.name)?
            .context("MCP_OAUTH_ASSOCIATION_UNAVAILABLE")?;
        let connection_generation =
            existing_generation(&self.directory, &format!("{}.generation", connection.name))?;
        let connection_revision = metadata_digest(&serde_json::json!([
            association_identity,
            connection_generation,
            saved.binding.resource.as_str(),
            saved.binding.issuer.as_str(),
            saved.binding.client_id,
            saved.binding.token_endpoint.as_str(),
            saved.redirect_uri.as_str()
        ]))?;
        if connection_generation.is_none() {
            return Ok(Some(metadata(
                binding_id,
                connection_revision,
                OAuthObservationState::Unknown,
                "MCP_OAUTH_AUTHORIZATION_GENERATION_UNAVAILABLE",
                None,
            )));
        }

        let registration_key = format!(
            "client-{}",
            crate::authorization_store::scoped_key(
                self.account.as_deref(),
                &serde_json::to_vec(&(
                    "registration",
                    saved.binding.issuer.as_str(),
                    saved.redirect_uri.as_str(),
                ))?
            )
        );
        let registration_lock =
            existing_lock(&self.directory, &format!("{registration_key}.lock"))?;
        let Some((client_bytes, client_identity)) =
            read_existing(&self.directory, &format!("{registration_key}.json"))?
        else {
            return Ok(Some(metadata(
                binding_id,
                connection_revision,
                OAuthObservationState::Unknown,
                "MCP_OAUTH_REGISTRATION_UNAVAILABLE",
                None,
            )));
        };
        let client =
            RegisteredClient::from_store_bytes(&client_bytes, &saved.metadata, &saved.redirect_uri)
                .map_err(|_| anyhow::anyhow!("MCP_OAUTH_REGISTRATION_INVALID"))?;
        if client.client_id() != saved.binding.client_id || client.authentication().is_err() {
            return Ok(Some(metadata(
                binding_id,
                connection_revision,
                OAuthObservationState::ReauthorizationRequired,
                "MCP_OAUTH_REGISTRATION_CHANGED",
                None,
            )));
        }
        drop(client);
        drop(client_bytes);
        drop(registration_lock);

        // Preserve the normal connection -> registration -> token lock order,
        // releasing registration before acquiring the token's existing lock.
        let token_key = crate::authorization_store::scoped_key(
            self.account.as_deref(),
            &serde_json::to_vec(&(
                saved.binding.resource.as_str(),
                saved.binding.issuer.as_str(),
                &saved.binding.client_id,
            ))?,
        );
        let token_name = format!("{token_key}.json");
        let _token_lock = existing_lock(&self.directory, &format!("{token_key}.lock"))?;
        let token_generation =
            existing_generation(&self.directory, &format!("{token_name}.generation"))?;
        let token_bytes = read_existing(&self.directory, &token_name)?;
        let revision_input = serde_json::json!([
            "native-oauth-authorization-v1",
            connection_revision,
            connection_generation,
            client_identity,
            token_generation,
            token_bytes.is_some()
        ]);
        let Some((token_bytes, _)) = token_bytes else {
            self.verify()?;
            return Ok(Some(metadata(
                binding_id,
                metadata_digest(&revision_input)?,
                OAuthObservationState::NotAuthorized,
                "MCP_OAUTH_CREDENTIAL_UNAVAILABLE",
                None,
            )));
        };
        let tokens = match OAuthTokens::from_store_bytes(
            &token_bytes,
            &saved.binding.resource,
            &saved.binding.issuer,
            &saved.binding.client_id,
            &saved.binding.token_endpoint,
        ) {
            Ok(tokens) => tokens,
            Err(error)
                if error
                    .downcast_ref::<crate::authorization_tokens::ProviderRevocationBlocked>()
                    .is_some() =>
            {
                self.verify()?;
                let accepted = error
                    .downcast_ref::<crate::authorization_tokens::ProviderRevocationBlocked>()
                    .unwrap()
                    .accepted;
                #[derive(Deserialize)]
                struct OriginalScope {
                    scope: Option<String>,
                }
                let scope: OriginalScope = serde_json::from_slice(&token_bytes)
                    .map_err(|_| anyhow::anyhow!("MCP_OAUTH_CREDENTIAL_INVALID"))?;
                return Ok(Some(metadata(
                    binding_id,
                    metadata_digest(&serde_json::json!([revision_input, scope.scope]))?,
                    if accepted {
                        OAuthObservationState::NotAuthorized
                    } else {
                        OAuthObservationState::ReauthorizationRequired
                    },
                    if accepted {
                        "MCP_OAUTH_PROVIDER_REVOCATION_ACCEPTED"
                    } else {
                        "MCP_OAUTH_PROVIDER_REVOCATION_UNCONFIRMED"
                    },
                    None,
                )));
            }
            Err(error) if error.downcast_ref::<RefreshRecoveryRequired>().is_some() => {
                self.verify()?;
                return Ok(Some(metadata(
                    binding_id,
                    metadata_digest(&revision_input)?,
                    OAuthObservationState::ReauthorizationRequired,
                    "MCP_OAUTH_REFRESH_OUTCOME_UNKNOWN",
                    None,
                )));
            }
            Err(_) => anyhow::bail!("MCP_OAUTH_CREDENTIAL_INVALID"),
        };
        #[derive(Deserialize)]
        struct Expiry {
            expires_at_ms: Option<u64>,
        }
        let expiry: Expiry = serde_json::from_slice(&token_bytes)
            .map_err(|_| anyhow::anyhow!("MCP_OAUTH_CREDENTIAL_INVALID"))?;
        let expired = tokens
            .expires_at()
            .is_some_and(|expiry| expiry <= Instant::now())
            || expiry.expires_at_ms.is_some_and(|expiry| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .is_ok_and(|now| u128::from(expiry) <= now.as_millis())
            });
        // Ordinary access-token refresh does not change account identity. Only
        // actual authorization metadata/generations/scopes enter this revision.
        let revision = metadata_digest(&serde_json::json!([revision_input, tokens.scope()]))?;
        drop(tokens);
        drop(token_bytes);
        self.verify()?;
        Ok(Some(metadata(
            binding_id,
            revision,
            if expired {
                OAuthObservationState::Expired
            } else {
                OAuthObservationState::Authorized
            },
            if expired {
                "MCP_OAUTH_CREDENTIAL_EXPIRED"
            } else {
                "MCP_OAUTH_AUTHORIZATION_OBSERVED"
            },
            expiry.expires_at_ms,
        )))
    }
}

fn metadata(
    binding_id: String,
    authorization_revision: String,
    state: OAuthObservationState,
    reason_code: &'static str,
    expires_at_ms: Option<u64>,
) -> OAuthPublicMetadata {
    OAuthPublicMetadata {
        binding_id,
        authorization_revision,
        state,
        reason_code,
        expires_at_ms,
    }
}
fn metadata_digest(value: &serde_json::Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
fn existing_lock(directory: &PrivateDirectory, name: &str) -> Result<VerifiedPrivateLease> {
    let identity = directory
        .portable_regular_identity(OsStr::new(name))
        .map_err(|_| anyhow::anyhow!("MCP_OAUTH_OBSERVATION_LOCK_UNAVAILABLE"))?;
    directory
        .try_existing_portable_lock(OsStr::new(name), &identity, PrivateLeaseMode::Shared)?
        .context("MCP_OAUTH_OBSERVATION_BUSY")
}
fn read_existing(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<(Zeroizing<Vec<u8>>, PortableLeaseIdentity)>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(_) => anyhow::bail!("MCP_OAUTH_OBSERVATION_RECORD_UNAVAILABLE"),
    };
    let identity = directory.portable_regular_handle_identity(&file)?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BYTES as usize
            && directory.portable_regular_identity(OsStr::new(name))? == identity,
        "MCP_OAUTH_OBSERVATION_RECORD_CHANGED"
    );
    Ok(Some((bytes, identity)))
}
fn existing_generation(directory: &PrivateDirectory, name: &str) -> Result<Option<String>> {
    let Some((bytes, _)) = read_existing(directory, name)? else {
        return Ok(None);
    };
    ensure!(
        bytes.len() == 64 && bytes.iter().all(u8::is_ascii_hexdigit),
        "MCP_OAUTH_GENERATION_INVALID"
    );
    Ok(Some(String::from_utf8(bytes.to_vec()).map_err(|_| {
        anyhow::anyhow!("MCP_OAUTH_GENERATION_INVALID")
    })?))
}

#[cfg(test)]
mod tests;

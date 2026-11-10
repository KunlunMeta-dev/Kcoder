//! Original native connection provenance, separate from server/tool labels.
use crate::{McpServerConfig, McpServerHandle, server_policy::CredentialContext};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStoreMode, OsCredentialBackend, PrivateDirectory,
};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Native-only connection birth evidence. No public JSON, Debug or independent
/// constructor can turn current configuration into an old connection's origin.
pub struct NativeMcpConnectionOrigin {
    config: McpServerConfig,
    profile: PrivateDirectory,
    profile_path: PathBuf,
    profile_identity: String,
    mode: CredentialStoreMode,
    credential_revision: Option<String>,
    oauth: Option<crate::authorization_index::observe::OAuthPublicMetadata>,
    lease: CancellationToken,
}
impl NativeMcpConnectionOrigin {
    /// The original private configuration is for native provenance only. It
    /// must never be serialized into public settings, model input or traces.
    pub fn private_config(&self) -> &McpServerConfig {
        &self.config
    }
    pub fn credential_mode(&self) -> CredentialStoreMode {
        self.mode
    }
    pub fn credential_revision(&self) -> Option<&str> {
        self.credential_revision.as_deref()
    }
    pub fn oauth_metadata(
        &self,
    ) -> Option<&crate::authorization_index::observe::OAuthPublicMetadata> {
        self.oauth.as_ref()
    }
    pub fn is_live(&self) -> bool {
        !self.lease.is_cancelled()
    }
    pub fn matches_profile(&self, profile: &PrivateDirectory) -> Result<bool> {
        self.verify_owner()?;
        Ok(profile.directory_identity()? == self.profile_identity)
    }
    pub fn verify_owner(&self) -> Result<()> {
        ensure!(self.is_live(), "MCP_NATIVE_CONNECTION_REVOKED");
        let current = PrivateDirectory::open_existing(&self.profile_path)?;
        current.verify_private_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && current.directory_identity()? == self.profile_identity,
            "MCP_NATIVE_PROFILE_CHANGED"
        );
        Ok(())
    }
    pub(crate) fn revoke(&self) {
        self.lease.cancel();
    }
    pub(crate) fn capture(
        config: &McpServerConfig,
        context: Option<&CredentialContext>,
    ) -> Result<Option<Arc<Self>>> {
        Self::capture_with_backend(config, context, &OsCredentialBackend::new())
    }
    fn capture_with_backend(
        config: &McpServerConfig,
        context: Option<&CredentialContext>,
        backend: &dyn CredentialBackend,
    ) -> Result<Option<Arc<Self>>> {
        // A connection without an explicit native target profile cannot borrow
        // an ambient profile merely to acquire a provenance stamp.
        let Some(context) = context else {
            return Ok(None);
        };
        let profile = PrivateDirectory::open_existing(&context.config_dir)?;
        profile.verify_private_directory()?;
        let profile_identity = profile.directory_identity()?;
        let credential_revision = if config.policy.credential_ref.is_some() {
            Some(
                kcoder_config::imported_credentials::ImportedCredentialStore::open(
                    &context.config_dir,
                )?
                .mcp_connection_revision(config, context.mode, backend)?,
            )
        } else {
            None
        };
        let oauth = observe_oauth(&profile, config)?;
        Ok(Some(Arc::new(Self {
            config: config.clone(),
            profile,
            profile_path: context.config_dir.clone(),
            profile_identity,
            mode: context.mode,
            credential_revision,
            oauth,
            lease: CancellationToken::new(),
        })))
    }
    pub(crate) fn still_same_credentials(&self) -> Result<bool> {
        self.still_same_credentials_with(&OsCredentialBackend::new())
    }
    fn still_same_credentials_with(&self, backend: &dyn CredentialBackend) -> Result<bool> {
        self.verify_owner()?;
        if observe_oauth(&self.profile, &self.config)? != self.oauth {
            return Ok(false);
        }
        match self.credential_revision.as_deref() {
            Some(original) => Ok(
                kcoder_config::imported_credentials::ImportedCredentialStore::open(
                    &self.profile_path,
                )?
                .mcp_connection_revision(&self.config, self.mode, backend)?
                    == original,
            ),
            None => Ok(true),
        }
    }

    /// A successful handshake may refresh the same authorization. Retain its
    /// actual owner and epoch while publishing the newly observed expiry/state.
    fn after_authorization_refresh(&self) -> Result<Arc<Self>> {
        use crate::authorization_index::observe::OAuthObservationState;
        self.verify_owner()?;
        let original = self
            .oauth
            .as_ref()
            .context("MCP_NATIVE_OAUTH_ORIGIN_REQUIRED")?;
        let current = observe_oauth(&self.profile, &self.config)?
            .context("MCP_NATIVE_OAUTH_CURRENT_REQUIRED")?;
        ensure!(
            self.credential_revision.is_none()
                && original.binding_id == current.binding_id
                && original.authorization_revision == current.authorization_revision
                && matches!(
                    original.state,
                    OAuthObservationState::Authorized | OAuthObservationState::Expired
                )
                && current.state == OAuthObservationState::Authorized,
            "MCP_NATIVE_OAUTH_AUTHORIZATION_CHANGED"
        );
        self.verify_owner()?;
        Ok(Arc::new(Self {
            config: self.config.clone(),
            profile: self.profile.duplicate_handle()?,
            profile_path: self.profile_path.clone(),
            profile_identity: self.profile_identity.clone(),
            mode: self.mode,
            credential_revision: self.credential_revision.clone(),
            oauth: Some(current),
            lease: self.lease.clone(),
        }))
    }
}

fn observe_oauth(
    profile: &PrivateDirectory,
    config: &McpServerConfig,
) -> Result<Option<crate::authorization_index::observe::OAuthPublicMetadata>> {
    if config.transport != "http" || config.policy.credential_ref.is_some() {
        return Ok(None);
    }
    let endpoint = reqwest::Url::parse(&config.url)
        .map_err(|_| anyhow::anyhow!("MCP_NATIVE_ENDPOINT_INVALID"))?;
    let Some(store) =
        crate::authorization_index::observe::ExistingOAuthObservationStore::open_existing_for_account(profile, config.policy.oauth_account.as_deref())?
    else {
        return Ok(None);
    };
    store.observe_connection(&endpoint)
}

/// Attach only after the actual handshake returns and original credential
/// revision is unchanged. Ordinary connection success does not imply this stamp.
pub(crate) async fn attach_after_connect(
    handle: &McpServerHandle,
    origin: Option<Arc<NativeMcpConnectionOrigin>>,
) {
    if let Some(origin) = origin {
        if origin.still_same_credentials().unwrap_or(false) {
            handle.lock().await.set_native_origin(origin);
        } else if let Ok(refreshed) = origin.after_authorization_refresh() {
            handle.lock().await.set_native_origin(refreshed);
        } else {
            origin.revoke();
        }
    }
}

#[cfg(test)]
mod tests;

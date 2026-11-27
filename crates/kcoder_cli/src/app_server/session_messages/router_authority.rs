//! Captured OS-parent boundary for the dedicated peer routing lane.
use super::router_store::NativePeerRouterStore;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{RetentionParentLaunchV1, RetentionPrincipalV1, cross_session_router::*};
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

const NAMESPACE: &str = "peer-router-v1";

pub struct NativePeerRouterAuthority {
    parent: RetentionParentLaunchV1,
    profile_path: PathBuf,
    profile: PrivateDirectory,
    profile_identity: String,
    workspace_path: PathBuf,
    workspace: PrivateDirectory,
    workspace_identity: String,
    workspace_id: String,
    store: NativePeerRouterStore,
    active: AtomicBool,
    transport: OnceLock<Arc<dyn PeerRouterTransportFence>>,
}
/// A held private transport's current kernel identity, never a grant from JSON.
pub trait PeerRouterTransportFence: Send + Sync {
    fn verify(&self) -> Result<()>;
}
pub struct PeerRouterConnectionGuard(Arc<NativePeerRouterAuthority>);
impl Drop for PeerRouterConnectionGuard {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::Release);
    }
}
#[derive(Clone, Copy)]
pub enum PeerRouteEndpoint {
    Source,
    Destination,
}

/// A non-serializable current private route. Source and destination selectors do
/// not replace this captured capability or the current per-session tool policy.
pub struct AuthorizedPeerRoute {
    authority: Arc<NativePeerRouterAuthority>,
    proof: PrivatePeerRouteProofV1,
    endpoint: PeerRouteEndpoint,
}
impl AuthorizedPeerRoute {
    pub fn verify(&self) -> Result<()> {
        self.authority.verify()?;
        self.proof.validate().map_err(anyhow::Error::msg)?;
        let expected = match self.endpoint {
            PeerRouteEndpoint::Source => &self.proof.source,
            PeerRouteEndpoint::Destination => &self.proof.destination,
        };
        ensure!(
            &self.authority.identity()? == expected,
            "peer_router_local_identity_changed"
        );
        Ok(())
    }
    pub fn proof(&self) -> &PrivatePeerRouteProofV1 {
        &self.proof
    }
}

impl NativePeerRouterAuthority {
    /// The connection supplies captured launch facts; no public JSON can create this boundary.
    /// Creation is permitted only at an explicit enabled-profile/load boundary.
    pub fn capture(
        parent: &RetentionParentLaunchV1,
        account_root: &Path,
        profile_path: &Path,
        workspace_path: &Path,
        allow_create: bool,
    ) -> Result<Option<Self>> {
        kcoder_host_transport::parent_identity::validate_identity(parent)?;
        #[cfg(not(unix))]
        ensure!(
            matches!(parent, RetentionParentLaunchV1::LocalOs),
            "peer_router_verified_account_unavailable"
        );
        let profile = PrivateDirectory::open_existing(profile_path)?;
        profile.verify_private_directory()?;
        let account = PrivateDirectory::open_existing(account_root)?;
        account.verify_private_directory()?;
        let profile_identity = profile.directory_identity()?;
        ensure!(
            account.directory_identity()? == profile_identity,
            "peer_router_launch_profile_changed"
        );
        let workspace_path = dunce::canonicalize(workspace_path)?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        let workspace_identity = workspace.directory_identity()?;
        let workspace_id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.peer-message.workspace.v1",
                &profile_identity,
                &workspace_identity,
            ))?)
        );
        // The key belongs to the physical OS-owned profile. A direct TUI and
        // an authenticated Studio launch must not allocate different keys for
        // that same profile merely because their transport principals differ.
        let principal = RetentionPrincipalV1::LocalOs;
        let store =
            match NativePeerRouterStore::open_in(&profile, OsStr::new(NAMESPACE), &principal)? {
                Some(store) => store,
                None if allow_create => match NativePeerRouterStore::create_in(
                    &profile,
                    OsStr::new(NAMESPACE),
                    &principal,
                ) {
                    Ok(store) => store,
                    // A simultaneous authorized initializer may have committed first.
                    // Reopen validates the entire existing namespace; it never repairs it.
                    Err(_) => {
                        NativePeerRouterStore::open_in(&profile, OsStr::new(NAMESPACE), &principal)?
                            .context("peer_router_initialization_unconfirmed")?
                    }
                },
                None => return Ok(None),
            };
        let authority = Self {
            parent: parent.clone(),
            profile_path: profile_path.to_owned(),
            profile,
            profile_identity,
            workspace_path,
            workspace,
            workspace_identity,
            workspace_id,
            store,
            active: AtomicBool::new(true),
            transport: OnceLock::new(),
        };
        authority.verify()?;
        Ok(Some(authority))
    }
    pub fn close_guard(self: &Arc<Self>) -> PeerRouterConnectionGuard {
        PeerRouterConnectionGuard(self.clone())
    }
    pub fn with_transport_fence(
        self,
        transport: Arc<dyn PeerRouterTransportFence>,
    ) -> Result<Self> {
        self.install_transport_fence(transport)?;
        Ok(self)
    }
    pub(crate) fn install_transport_fence(
        &self,
        transport: Arc<dyn PeerRouterTransportFence>,
    ) -> Result<()> {
        transport.verify()?;
        self.transport
            .set(transport)
            .map_err(|_| anyhow::anyhow!("peer_router_transport_already_bound"))?;
        self.verify()
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn ssh_profile_path(&self) -> Result<&Path> {
        self.verify()?;
        Ok(&self.profile_path)
    }
    pub fn close(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.active.load(Ordering::Acquire),
            "peer_router_connection_closed"
        );
        if let Some(transport) = self.transport.get() {
            transport.verify()?;
        }
        kcoder_host_transport::parent_identity::validate_identity(&self.parent)?;
        self.profile.verify_private_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                    == self.profile_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace_identity,
            "peer_router_scope_changed"
        );
        Ok(())
    }
    pub fn identity(&self) -> Result<PeerRouterIdentityV1> {
        self.verify()?;
        let mut identity = self.store.identity(&self.workspace_id)?;
        identity.principal = match &self.parent {
            RetentionParentLaunchV1::LocalOs => RetentionPrincipalV1::LocalOs,
            RetentionParentLaunchV1::VerifiedAccount { principal_id, .. } => {
                RetentionPrincipalV1::VerifiedAccount {
                    principal_id: principal_id.clone(),
                }
            }
        };
        Ok(identity)
    }
    pub fn store(&self) -> Result<&NativePeerRouterStore> {
        self.verify()?;
        Ok(&self.store)
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn ssh_profile_observation(&self) -> Result<ssh_enrollment::PeerSshNativeProfileV1> {
        let identity = self.identity()?;
        let text = |value: String| value.try_into().map_err(anyhow::Error::msg);
        ensure!(
            matches!(self.parent, RetentionParentLaunchV1::LocalOs),
            "peer_ssh_enrollment_account_purpose_unavailable"
        );
        Ok(ssh_enrollment::PeerSshNativeProfileV1 {
            account_uid: unsafe { libc::geteuid() },
            profile_identity: text(self.profile_identity.clone())?,
            target_id: text(identity.target_id)?,
            workspace_id: text(identity.workspace_id)?,
            identity_epoch: text(identity.identity_epoch)?,
            public_key: identity
                .public_key
                .try_into()
                .map_err(|_| anyhow::anyhow!("peer_ssh_native_key_invalid"))?,
        })
    }
    /// Call only after the private request decoder accepted the original frame.
    pub fn authorize_private_route(
        self: &Arc<Self>,
        proof: PrivatePeerRouteProofV1,
        endpoint: PeerRouteEndpoint,
    ) -> Result<AuthorizedPeerRoute> {
        let route = AuthorizedPeerRoute {
            authority: self.clone(),
            proof,
            endpoint,
        };
        route.verify()?;
        Ok(route)
    }
}

#[cfg(test)]
#[path = "router_authority/tests.rs"]
mod tests;

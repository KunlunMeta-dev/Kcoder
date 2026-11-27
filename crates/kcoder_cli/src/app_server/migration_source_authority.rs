//! Portable profile authority derived from the captured OS-parent launch, never client params.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    MigrationSourceRoleV1, PrivateMigrationSourceProofV1, RetentionParentLaunchV1,
    RetentionPrincipalV1,
};
use kcoder_config::PrivateDirectory;
use kcoder_migration::source_transfer::{
    IncomingTransfers, RecoveredTargetTransfer, SourceTransfers, TransferAuthority,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct ProfileAuthority {
    path: PathBuf,
    directory: PrivateDirectory,
    identity: String,
    parent: RetentionParentLaunchV1,
    active: AtomicBool,
    native: Mutex<Option<Arc<SourceTransfers>>>,
}
impl ProfileAuthority {
    fn verify_profile(&self) -> Result<()> {
        ensure!(
            self.active.load(Ordering::Acquire),
            "source_transfer_connection_closed"
        );
        self.directory.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&self.path)?;
        current.verify_private_directory()?;
        ensure!(
            current.directory_identity()? == self.identity,
            "source_transfer_owner_changed"
        );
        Ok(())
    }
    fn native(&self) -> Result<Arc<SourceTransfers>> {
        self.verify_profile()?;
        let mut slot = self
            .native
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        if slot.is_none() {
            *slot = Some(Arc::new(SourceTransfers::open(&self.path)?));
        }
        let source = slot.as_ref().unwrap().clone();
        source.verify_authority()?;
        self.verify_profile()?;
        Ok(source)
    }
    fn principal_matches(&self, principal: &RetentionPrincipalV1) -> bool {
        match (&self.parent, principal) {
            (RetentionParentLaunchV1::LocalOs, RetentionPrincipalV1::LocalOs) => true,
            (
                RetentionParentLaunchV1::VerifiedAccount {
                    principal_id: expected,
                    ..
                },
                RetentionPrincipalV1::VerifiedAccount { principal_id },
            ) => expected == principal_id,
            _ => false,
        }
    }
}

pub struct MigrationSourceAuthority {
    scope: Arc<ProfileAuthority>,
    peers: Mutex<HashMap<String, AuthorizedMigrationPeer>>,
}
pub struct MigrationSourceConnectionGuard(Arc<MigrationSourceAuthority>);
impl Drop for MigrationSourceConnectionGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Only the private connection boundary can construct this capability. It is not deserializable.
#[derive(Clone)]
pub struct AuthorizedMigrationPeer {
    scope: Arc<ProfileAuthority>,
    request: String,
    role: MigrationSourceRoleV1,
    source: TransferAuthority,
    target: TransferAuthority,
    authorization: PeerAuthorization,
}

#[derive(Clone, PartialEq, Eq)]
enum PeerAuthorization {
    Paired(Box<PrivateMigrationSourceProofV1>),
    RecoveredTarget(RecoveredTargetTransfer),
}
impl AuthorizedMigrationPeer {
    pub fn request_id(&self) -> &str {
        &self.request
    }
    pub fn role(&self) -> &str {
        match self.role {
            MigrationSourceRoleV1::Source => "source",
            MigrationSourceRoleV1::Target => "target",
        }
    }
    pub fn source_authority(&self) -> &TransferAuthority {
        &self.source
    }
    pub fn target_authority(&self) -> &TransferAuthority {
        &self.target
    }
    pub fn profile(&self) -> &Path {
        &self.scope.path
    }
    pub fn validate(&self) -> Result<()> {
        if let PeerAuthorization::RecoveredTarget(expected) = &self.authorization {
            self.scope.verify_profile()?;
            let target = IncomingTransfers::open_existing(&self.scope.path)?;
            ensure!(
                target.authority() == &self.target
                    && target.recover_target(&self.request)? == *expected,
                "source_transfer_owner_changed"
            );
            self.scope.verify_profile()?;
            return Ok(());
        }
        let native = self.scope.native()?;
        let expected = match self.role {
            MigrationSourceRoleV1::Source => &self.source,
            MigrationSourceRoleV1::Target => &self.target,
        };
        ensure!(
            native.authority() == expected,
            "source_transfer_owner_changed"
        );
        Ok(())
    }
    pub fn recovery_only(&self) -> bool {
        matches!(self.authorization, PeerAuthorization::RecoveredTarget(_))
    }
    pub fn same_authorization(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.scope, &other.scope)
            && self.request == other.request
            && self.role == other.role
            && self.source == other.source
            && self.target == other.target
            && self.authorization == other.authorization
    }
    pub fn permits(&self, operation: &str) -> bool {
        !self.recovery_only()
            || matches!(
                operation,
                "target/state"
                    | "target/summary"
                    | "target/receipt"
                    | "target/cancel"
                    | "target/resume"
                    | "target/finish"
                    | "target/attempt/read"
                    | "target/attempt/claim"
                    | "target/attempt/release"
                    | "target/received/read"
                    | "target/adoption/prepare"
                    | "target/adoption/read"
                    | "target/adoption/resume"
                    | "target/adoption/cancel"
                    | "target/private/candidates"
                    | "target/private/read"
                    | "target/private/accept"
                    | "target/private/cancel"
                    | "target/private/resume"
                    | "target/private/prepare-status"
                    | "target/private/prepare"
                    | "target/private/release"
            )
    }
}

impl MigrationSourceAuthority {
    pub fn close_guard(self: &Arc<Self>) -> MigrationSourceConnectionGuard {
        MigrationSourceConnectionGuard(self.clone())
    }
    pub fn capture(
        parent: &RetentionParentLaunchV1,
        account_root: &Path,
        profile: &Path,
    ) -> Result<Self> {
        kcoder_host_transport::parent_identity::validate_identity(parent)?;
        #[cfg(not(unix))]
        ensure!(
            matches!(parent, RetentionParentLaunchV1::LocalOs),
            "source_transfer_verified_account_unavailable"
        );
        ensure!(profile.is_absolute(), "source_transfer_invalid_profile");
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_private_directory()?;
        let identity = directory.directory_identity()?;
        let parent_root = PrivateDirectory::open_existing(account_root)?;
        parent_root.verify_private_directory()?;
        ensure!(
            parent_root.directory_identity()? == identity,
            "source_transfer_launch_profile_changed"
        );
        Ok(Self {
            scope: Arc::new(ProfileAuthority {
                path: profile.into(),
                directory,
                identity,
                parent: parent.clone(),
                active: AtomicBool::new(true),
                native: Mutex::new(None),
            }),
            peers: Mutex::new(HashMap::new()),
        })
    }
    pub fn observe_private_source(
        &self,
        request: &str,
        offer: &str,
    ) -> Result<kcoder_migration::source_transfer::private_credentials::PrivateCredentialObservation>
    {
        self.scope.verify_profile()?;
        let observation=kcoder_migration::source_transfer::private_credentials::observe_existing_source_private_credentials(&self.scope.path,request,offer)?;
        self.scope.verify_profile()?;
        Ok(observation)
    }
    pub fn identity(&self) -> Result<TransferAuthority> {
        Ok(self.scope.native()?.authority().clone())
    }
    pub fn accept(
        &self,
        role: MigrationSourceRoleV1,
        proof: PrivateMigrationSourceProofV1,
    ) -> Result<String> {
        ensure!(proof.valid(), "source_transfer_invalid_peer_proof");
        let native = self.identity()?;
        let endpoint = match role {
            MigrationSourceRoleV1::Source => &proof.source,
            MigrationSourceRoleV1::Target => &proof.target,
        };
        ensure!(
            self.scope.principal_matches(&endpoint.principal)
                && native.instance_id == endpoint.authority.instance_id
                && native.account_id == endpoint.authority.account_id,
            "source_transfer_peer_authority_changed"
        );
        let mut peers = self
            .peers
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        if let Some((reference, peer)) = peers.iter().find(|(_, peer)| {
            peer.request == proof.request_id && peer.role == role && !peer.recovery_only()
        }) {
            ensure!(
                peer.authorization == PeerAuthorization::Paired(Box::new(proof.clone())),
                "source_transfer_peer_conflict"
            );
            peer.validate()?;
            return Ok(reference.clone());
        }
        ensure!(peers.len() < 64, "source_transfer_peer_capacity");
        let reference = uuid::Uuid::new_v4().to_string();
        let convert = |value: &kcoder_app_protocol::MigrationSourceAuthorityV1| TransferAuthority {
            instance_id: value.instance_id.clone(),
            account_id: value.account_id.clone(),
        };
        peers.insert(
            reference.clone(),
            AuthorizedMigrationPeer {
                scope: self.scope.clone(),
                request: proof.request_id.clone(),
                role,
                source: convert(&proof.source.authority),
                target: convert(&proof.target.authority),
                authorization: PeerAuthorization::Paired(Box::new(proof)),
            },
        );
        Ok(reference)
    }
    pub fn recover_target(&self, request: &str) -> Result<(String, TransferAuthority)> {
        self.scope.verify_profile()?;
        let target = IncomingTransfers::open_existing(&self.scope.path)?;
        let recovered = target.recover_target(request)?;
        self.scope.verify_profile()?;
        let mut peers = self
            .peers
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        if let Some((reference, peer)) = peers
            .iter()
            .find(|(_, peer)| peer.request == request && peer.recovery_only())
        {
            ensure!(
                peer.authorization == PeerAuthorization::RecoveredTarget(recovered),
                "source_transfer_peer_conflict"
            );
            peer.validate()?;
            return Ok((reference.clone(), target.authority().clone()));
        }
        ensure!(peers.len() < 64, "source_transfer_peer_capacity");
        let reference = uuid::Uuid::new_v4().to_string();
        peers.insert(
            reference.clone(),
            AuthorizedMigrationPeer {
                scope: self.scope.clone(),
                request: request.into(),
                role: MigrationSourceRoleV1::Target,
                source: recovered.source_authority().clone(),
                target: target.authority().clone(),
                authorization: PeerAuthorization::RecoveredTarget(recovered),
            },
        );
        Ok((reference, target.authority().clone()))
    }
    pub fn peer(&self, request_id: &str, reference: &str) -> Result<AuthorizedMigrationPeer> {
        let peer = self
            .peers
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?
            .get(reference)
            .cloned()
            .context("source_transfer_peer_unavailable")?;
        ensure!(
            peer.request == request_id,
            "source_transfer_peer_request_changed"
        );
        peer.validate()?;
        Ok(peer)
    }
    pub fn close(&self) {
        self.scope.active.store(false, Ordering::Release);
    }
}
impl Drop for MigrationSourceAuthority {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
#[path = "migration_source_authority/recovery_tests.rs"]
mod recovery_tests;
#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_protocol::{MigrationSourceAuthorityV1, MigrationSourceEndpointV1};

    pub fn owned() -> (tempfile::TempDir, MigrationSourceAuthority) {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        PrivateDirectory::open_or_create(&profile).unwrap();
        let authority = MigrationSourceAuthority::capture(
            &RetentionParentLaunchV1::LocalOs,
            &profile,
            &profile,
        )
        .unwrap();
        (root, authority)
    }
    pub fn proof(authority: &MigrationSourceAuthority) -> PrivateMigrationSourceProofV1 {
        let identity = authority.identity().unwrap();
        let endpoint = MigrationSourceEndpointV1 {
            authority: MigrationSourceAuthorityV1 {
                instance_id: identity.instance_id,
                account_id: identity.account_id,
            },
            target_fingerprint: "owned-target".into(),
            principal: RetentionPrincipalV1::LocalOs,
        };
        PrivateMigrationSourceProofV1 {
            version: 1,
            request_id: uuid::Uuid::new_v4().to_string(),
            source: endpoint.clone(),
            target: endpoint,
        }
    }
    #[test]
    fn peers_are_request_role_parent_and_endpoint_bound() {
        let (_root, authority) = owned();
        let proof = proof(&authority);
        let reference = authority
            .accept(MigrationSourceRoleV1::Source, proof.clone())
            .unwrap();
        assert_eq!(
            authority
                .accept(MigrationSourceRoleV1::Source, proof.clone())
                .unwrap(),
            reference
        );
        let peer = authority.peer(&proof.request_id, &reference).unwrap();
        assert_eq!(peer.role(), "source");
        assert!(
            authority
                .peer(&uuid::Uuid::new_v4().to_string(), &reference)
                .is_err()
        );
        let mut other = proof.clone();
        other.target.target_fingerprint = "different-route".into();
        assert!(
            authority
                .accept(MigrationSourceRoleV1::Source, other)
                .is_err()
        );
        let mut wrong = proof.clone();
        wrong.source.authority.account_id = "f".repeat(64);
        assert!(
            authority
                .accept(MigrationSourceRoleV1::Source, wrong)
                .is_err()
        );
        let mut wrong = proof;
        wrong.source.principal = RetentionPrincipalV1::VerifiedAccount {
            principal_id: "foreign-user".into(),
        };
        assert!(
            authority
                .accept(MigrationSourceRoleV1::Source, wrong)
                .is_err()
        );
        authority.close();
        assert!(peer.validate().is_err());
    }
    #[test]
    fn missing_native_identity_is_not_recreated_by_an_existing_peer() {
        let (root, authority) = owned();
        let proof = proof(&authority);
        let reference = authority
            .accept(MigrationSourceRoleV1::Source, proof.clone())
            .unwrap();
        let peer = authority.peer(&proof.request_id, &reference).unwrap();
        let identity = root
            .path()
            .join("profile/migrations/source-transfer/native.json");
        std::fs::remove_file(&identity).unwrap();
        assert!(peer.validate().is_err());
        assert!(!identity.exists());
    }
    #[test]
    fn profile_replacement_cannot_redirect_a_held_peer_or_repair_the_new_directory() {
        let (root, authority) = owned();
        let proof = proof(&authority);
        let reference = authority
            .accept(MigrationSourceRoleV1::Target, proof.clone())
            .unwrap();
        let peer = authority.peer(&proof.request_id, &reference).unwrap();
        let profile = root.path().join("profile");
        std::fs::rename(&profile, root.path().join("original")).unwrap();
        PrivateDirectory::open_or_create(&profile).unwrap();
        assert!(peer.validate().is_err());
        assert!(!profile.join("migrations").exists());
    }
}

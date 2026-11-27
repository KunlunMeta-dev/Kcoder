//! A stored explicit pin plus this process's held stdio and fresh mutual proof.
//! No sshd /proc inspection, ptrace privilege, argv nonce or environment grant is used.
use super::router_authority::{NativePeerRouterAuthority, PeerRouterTransportFence};
use anyhow::{Result, ensure};
use kcoder_app_protocol::cross_session_router::ssh_enrollment::*;
use kcoder_host_transport::{
    ssh_peer_facts::{MAX_CHALLENGE_LIFETIME, NativeSshFactChallenge},
    ssh_peer_pins::{SshPeerPinStore, StoredSshPeerPin},
};
use std::{
    fs::File,
    os::{
        fd::{FromRawFd, RawFd},
        unix::fs::MetadataExt,
    },
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(PartialEq, Eq)]
struct StreamIdentity {
    device: u64,
    inode: u64,
    kind: u32,
}
fn identity(file: &File) -> Result<StreamIdentity> {
    let metadata = file.metadata()?;
    let identity = StreamIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        kind: metadata.mode() & libc::S_IFMT,
    };
    ensure!(
        matches!(identity.kind, libc::S_IFIFO | libc::S_IFSOCK),
        "peer_ssh_stdio_not_stream"
    );
    Ok(identity)
}
fn duplicate(fd: RawFd) -> Result<File> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    ensure!(duplicated >= 0, "peer_ssh_stdio_unavailable");
    // SAFETY: F_DUPFD_CLOEXEC returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(duplicated) })
}

pub(crate) struct CapturedEnrolledSshParent {
    authority: Weak<NativePeerRouterAuthority>,
    actual: PeerSshNativeProfileV1,
    pin: StoredSshPeerPin,
    stdin: File,
    stdout: File,
    pid: u32,
    active: AtomicBool,
    completed: AtomicBool,
    challenge: Mutex<NativeSshFactChallenge>,
}
impl CapturedEnrolledSshParent {
    /// Only the real factory's captured authority selects the profile/key/root.
    /// The selector cannot supply pins; missing/revoked data fails before signing.
    pub(crate) fn capture(
        authority: &Arc<NativePeerRouterAuthority>,
        selector: &str,
    ) -> Result<Arc<Self>> {
        let id: PeerSshIdentityTextV1 =
            selector.to_owned().try_into().map_err(anyhow::Error::msg)?;
        let actual = authority.ssh_profile_observation()?;
        ensure!(
            unsafe { libc::getuid() } == actual.account_uid,
            "peer_ssh_real_uid_changed"
        );
        let store = SshPeerPinStore::open_existing(authority.ssh_profile_path()?)?
            .ok_or_else(|| anyhow::anyhow!("peer_ssh_pinned_enrollment_missing"))?;
        let pin = store
            .current_pin(&id, &actual)?
            .ok_or_else(|| anyhow::anyhow!("peer_ssh_pinned_enrollment_missing"))?;
        let stdin = duplicate(libc::STDIN_FILENO)?;
        let stdout = duplicate(libc::STDOUT_FILENO)?;
        identity(&stdin)?;
        identity(&stdout)?;
        let challenge = NativeSshFactChallenge::new(Some(pin.expected()), MAX_CHALLENGE_LIFETIME)?;
        let captured = Arc::new(Self {
            authority: Arc::downgrade(authority),
            actual,
            pin,
            stdin,
            stdout,
            pid: std::process::id(),
            active: AtomicBool::new(true),
            completed: AtomicBool::new(false),
            challenge: Mutex::new(challenge),
        });
        captured.verify()?;
        Ok(captured)
    }
    pub(crate) fn completed(&self) -> bool {
        self.completed.load(Ordering::Acquire)
    }
    pub(crate) fn close(&self) {
        self.active.store(false, Ordering::Release);
        self.completed.store(false, Ordering::Release);
        if let Ok(mut challenge) = self.challenge.lock() {
            challenge.close();
        }
    }
    pub(crate) fn offer(
        &self,
        request: PeerSshAuthOfferParamsV1,
    ) -> Result<PeerSshChallengeOfferV1> {
        self.verify()?;
        ensure!(
            !self.completed() && request.enrollment_id == self.pin.expected().enrollment_id,
            "peer_ssh_challenge_selector_changed"
        );
        let challenge = self
            .challenge
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_ssh_challenge_unavailable"))?;
        Ok(challenge.offer().clone())
    }
    pub(crate) fn native_proof(
        &self,
        request: PeerSshAuthNativeProofParamsV1,
    ) -> Result<PeerSshNativeProofV1> {
        self.verify()?;
        ensure!(!self.completed(), "peer_ssh_challenge_consumed");
        let authority = self
            .authority
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("peer_ssh_factory_owner_closed"))?;
        ensure!(
            authority.ssh_profile_observation()? == self.actual,
            "peer_ssh_factory_profile_changed"
        );
        let claims = request.claims.clone();
        let mut challenge = self
            .challenge
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_ssh_challenge_unavailable"))?;
        let proof = challenge.respond(request.claims, Some(self.pin.expected()), |_| {
            authority
                .store()
                .and_then(|store| store.sign_ssh_native_facts(&claims))
                .map_err(|_| {
                    kcoder_host_transport::ssh_peer_facts::SshPeerFactError::SignatureInvalid
                })
        })?;
        self.verify()?;
        Ok(proof)
    }
    pub(crate) fn complete(
        &self,
        request: PeerSshAuthCompleteParamsV1,
    ) -> Result<PeerSshAuthCompleteResultV1> {
        self.verify()?;
        ensure!(!self.completed(), "peer_ssh_challenge_consumed");
        let authority = self
            .authority
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("peer_ssh_factory_owner_closed"))?;
        ensure!(
            authority.ssh_profile_observation()? == self.actual,
            "peer_ssh_factory_profile_changed"
        );
        let mut challenge = self
            .challenge
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_ssh_challenge_unavailable"))?;
        let facts = challenge.finish(request.proof, Some(self.pin.expected()))?;
        self.verify()?;
        let claims = facts.claims();
        let result = PeerSshAuthCompleteResultV1 {
            version: 1,
            enrollment_id: self.pin.expected().enrollment_id.clone(),
            generation: self.pin.expected().generation,
            process_instance: claims.process_instance.clone(),
        };
        // This flag records this completed handshake only. Every private use still
        // verifies the real factory, current stored pin and original held stdio.
        self.completed.store(true, Ordering::Release);
        Ok(result)
    }
}
impl PeerRouterTransportFence for CapturedEnrolledSshParent {
    /// A pending fence checks lifetime/pins only; it never grants a private route.
    fn verify(&self) -> Result<()> {
        ensure!(
            self.active.load(Ordering::Acquire)
                && self.pid == std::process::id()
                && unsafe { libc::geteuid() } == self.actual.account_uid
                && unsafe { libc::getuid() } == self.actual.account_uid,
            "peer_ssh_transport_owner_changed"
        );
        ensure!(
            identity(&self.stdin)? == identity(&duplicate(libc::STDIN_FILENO)?)?
                && identity(&self.stdout)? == identity(&duplicate(libc::STDOUT_FILENO)?)?,
            "peer_ssh_stdio_owner_changed"
        );
        self.pin.verify_current(&self.actual)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "ssh_enrolled/tests.rs"]
mod tests;

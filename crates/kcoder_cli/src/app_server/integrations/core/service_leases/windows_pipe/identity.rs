//! Actual current-SID process/image ownership shared by readiness and async pipes.
use super::*;
use std::os::windows::io::RawHandle;
pub struct PipePeerIdentity {
    peer: OwnedHandle,
    image: WindowsServiceImage,
    account: PipeAccount,
    peer_token: Option<WindowsPeerTokenWitness>,
}
impl PipePeerIdentity {
    pub(super) fn capture_same_image(
        pipe: RawHandle,
        server: bool,
        image: &WindowsServiceImage,
    ) -> Result<Self> {
        Self::capture_same_image_account(pipe, server, image, PipeAccount::service()?)
    }
    pub(super) fn capture_same_image_account(
        pipe: RawHandle,
        server: bool,
        image: &WindowsServiceImage,
        account: PipeAccount,
    ) -> Result<Self> {
        let mut pid = 0;
        let result = unsafe {
            if server {
                GetNamedPipeClientProcessId(pipe.cast(), &mut pid)
            } else {
                GetNamedPipeServerProcessId(pipe.cast(), &mut pid)
            }
        };
        ensure!(
            result != 0 && pid > 0,
            "SERVICE_WINDOWS_PIPE_PEER_UNAVAILABLE"
        );
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        ensure!(!raw.is_null(), "SERVICE_WINDOWS_PIPE_PEER_UNAVAILABLE");
        let peer = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        account.verify_owned_process(peer.as_handle())?;
        let peer_token = match &account {
            PipeAccount::PeerSource(a) => Some(a.capture_process(peer.as_handle())?),
            PipeAccount::Service(_) => None,
        };
        let image = image.same_file_peer(peer.as_handle())?;
        let value = Self {
            peer,
            image,
            account,
            peer_token,
        };
        value.verify()?;
        Ok(value)
    }
    pub(super) fn capture(pipe: RawHandle, server: bool, image_sha: &str) -> Result<Self> {
        let account = PipeAccount::service()?;
        let mut pid = 0;
        let result = unsafe {
            if server {
                GetNamedPipeClientProcessId(pipe.cast(), &mut pid)
            } else {
                GetNamedPipeServerProcessId(pipe.cast(), &mut pid)
            }
        };
        ensure!(
            result != 0 && pid > 0,
            "SERVICE_WINDOWS_PIPE_PEER_UNAVAILABLE"
        );
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        ensure!(!raw.is_null(), "SERVICE_WINDOWS_PIPE_PEER_UNAVAILABLE");
        let peer = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        account.verify_owned_process(peer.as_handle())?;
        let image = WindowsServiceImage::capture(peer.as_handle(), &CancellationToken::new())?;
        ensure!(
            image.sha256() == image_sha,
            "SERVICE_WINDOWS_PIPE_PEER_IMAGE_DENIED"
        );
        let value = Self {
            peer,
            image,
            account,
            peer_token: None,
        };
        value.verify()?;
        Ok(value)
    }
    pub fn verify(&self) -> Result<()> {
        match (&self.account, &self.peer_token) {
            (PipeAccount::PeerSource(a), Some(token)) => token.verify(a, self.peer.as_handle())?,
            (PipeAccount::Service(a), None) => a.verify_owned_process(self.peer.as_handle())?,
            _ => anyhow::bail!("PEER_SOURCE_WINDOWS_TOKEN_WITNESS_REQUIRED"),
        }
        self.image.verify(self.peer.as_handle())
    }
    pub(super) fn is_peer_source(&self) -> bool {
        matches!(self.account, PipeAccount::PeerSource(_))
    }
    pub(super) fn maximum_frame(&self) -> usize {
        if self.is_peer_source() {
            128 * 1024
        } else {
            16384
        }
    }
    pub fn require_process(&self, original: BorrowedHandle<'_>) -> Result<()> {
        self.verify()?;
        self.account.verify_owned_process(original)?;
        ensure!(
            unsafe { GetProcessId(original.as_raw_handle().cast()) }
                == unsafe { GetProcessId(self.peer.as_raw_handle().cast()) },
            "SERVICE_WINDOWS_PIPE_ORIGINAL_CHILD_MISMATCH"
        );
        Ok(())
    }
    /// Source workers cannot register as UI even when transient launcher
    /// ancestry is no longer enumerable. The original Job is the live fence.
    pub fn verify_external_scope_ui(
        &self,
        job: &kcoder_process_supervisor::suspended_child::NamedJobQuery,
        manager: BorrowedHandle<'_>,
    ) -> Result<()> {
        ensure!(
            !self.is_peer_source(),
            "PEER_SOURCE_WINDOWS_PIPE_NOT_SERVICE_UI"
        );
        self.verify()?;
        self.account.verify_owned_process(manager)?;
        let original_manager = unsafe { GetProcessId(manager.as_raw_handle().cast()) };
        let peer = unsafe { GetProcessId(self.peer.as_raw_handle().cast()) };
        ensure!(
            original_manager > 0
                && peer > 0
                && original_manager != peer
                && !job.contains_process(self.peer.as_handle())?,
            "CHANNEL_PEER_MANAGED_SOURCE_CANNOT_REGISTER_UI"
        );
        self.verify()?;
        eprintln!(
            "{}",
            serde_json::json!({"event":"native_scope_original_ui_process_verified","sameOriginalManager":false,"inOriginalScopeJob":false})
        );
        Ok(())
    }
}

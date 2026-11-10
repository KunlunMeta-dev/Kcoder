//! Actual current-SID process/image ownership shared by readiness and async pipes.
use super::*;
use std::os::windows::io::RawHandle;
pub struct PipePeerIdentity {
    peer: OwnedHandle,
    image: WindowsServiceImage,
    account: CurrentWindowsServiceAccount,
}
impl PipePeerIdentity {
    pub(super) fn capture(pipe: RawHandle, server: bool, image_sha: &str) -> Result<Self> {
        let account = CurrentWindowsServiceAccount::capture()?;
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
        };
        value.verify()?;
        Ok(value)
    }
    pub fn verify(&self) -> Result<()> {
        self.account.verify_owned_process(self.peer.as_handle())?;
        self.image.verify(self.peer.as_handle())
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

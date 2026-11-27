//! Actual process and existing kernel lease ownership, never a historical PID record.
use super::image::NativeServiceImage;
use super::*;
use anyhow::{Context, ensure};
use kcoder_config::VerifiedPrivateLease;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use kcoder_native_scope::service_identity::verify_current_unix_account;
#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd};

pub struct NativeServiceProcess {
    #[cfg(target_os = "linux")]
    pidfd: OwnedFd,
    #[cfg(target_os = "linux")]
    parent_pidfd: OwnedFd,
    pid: u32,
    #[cfg(target_os = "linux")]
    uid: u32,
    #[cfg(windows)]
    windows: WindowsOwner,
    #[cfg(target_os = "macos")]
    macos: (u32, kcoder_process_supervisor::macos::ProcessHandle),
    image: NativeServiceImage,
    _lease: NativeProcessLease,
}
enum NativeProcessLease {
    Service { _owner: VerifiedPrivateLease },
    // This same open-file description is also held by the real scope owner
    // until its complete Core/SDK tree has exited. Dropping a duplicate must
    // not explicitly unlock the original owner's portable lease.
    Infrastructure(std::fs::File),
}
#[cfg(windows)]
struct WindowsOwner {
    account: super::windows_account::CurrentWindowsServiceAccount,
    process: std::os::windows::io::OwnedHandle,
    parent: std::os::windows::io::OwnedHandle,
    parent_image: super::windows_image::WindowsServiceImage,
    scope_job: Option<kcoder_process_supervisor::suspended_child::NamedJobQuery>,
}
impl NativeServiceProcess {
    #[cfg(target_os = "macos")]
    fn capture_owned_macos(
        expected: &str,
        image: NativeServiceImage,
        lease: NativeProcessLease,
    ) -> Result<Self> {
        let uid = unsafe { libc::getuid() };
        verify_current_unix_account()?;
        image.verify()?;
        ensure!(image.sha256() == expected, "SERVICE_NATIVE_IMAGE_CHANGED");
        let parent = unsafe { libc::getppid() };
        let process = kcoder_process_supervisor::macos::ProcessHandle::capture(parent as u32)?;
        ensure!(
            unsafe { libc::getppid() } == parent,
            "SERVICE_PROCESS_PARENT_CHANGED"
        );
        let value = Self {
            pid: std::process::id(),
            image,
            _lease: lease,
            macos: (uid, process),
        };
        value.verify()?;
        Ok(value)
    }
    #[cfg(windows)]
    fn capture_owned_windows(
        expected_image: &str,
        image: NativeServiceImage,
        lease: NativeProcessLease,
        gateway_owned: bool,
    ) -> Result<Self> {
        use std::os::windows::io::{AsHandle, BorrowedHandle};
        let account = super::windows_account::CurrentWindowsServiceAccount::capture()?;
        let process = unsafe {
            BorrowedHandle::borrow_raw(
                windows_sys::Win32::System::Threading::GetCurrentProcess().cast(),
            )
        }
        .try_clone_to_owned()?;
        account.verify_owned_process(process.as_handle())?;
        let parent =
            kcoder_host_transport::native_component_parent::capture_current_service_parent()?;
        account.verify_owned_process(parent.as_handle())?;
        let parent_image = super::windows_image::WindowsServiceImage::capture(
            parent.as_handle(),
            &tokio_util::sync::CancellationToken::new(),
        )?;
        image.verify()?;
        ensure!(
            image.sha256() == expected_image
                && (gateway_owned || parent_image.sha256() == image.sha256()),
            "SERVICE_NATIVE_IMAGE_CHANGED"
        );
        let value = Self {
            pid: std::process::id(),
            image,
            _lease: lease,
            windows: WindowsOwner {
                account,
                process,
                parent,
                parent_image,
                scope_job: None,
            },
        };
        value.verify()?;
        Ok(value)
    }
    #[cfg(target_os = "linux")]
    pub fn capture_native_code(
        native: &NativeIntegrationContext,
        record: &NativeCodeServiceRecord,
        storage: &NativeServiceLeases,
        image: NativeServiceImage,
    ) -> Result<Self> {
        native.validate_scope(&record.intent.scope)?;
        verify_current_unix_account()?;
        let lease = storage
            .store(native)?
            .claim_native_code_owner(&record.intent.lease_id)?
            .context("SERVICE_ORIGINAL_OWNER_BUSY")?;
        Self::capture_owned(
            &record.intent.native_image_sha256,
            image,
            NativeProcessLease::Service { _owner: lease },
        )
    }
    #[cfg(target_os = "linux")]
    fn capture_owned(
        expected_image_sha256: &str,
        image: NativeServiceImage,
        lease: NativeProcessLease,
    ) -> Result<Self> {
        let uid = unsafe { libc::getuid() };
        verify_current_unix_account()?;
        ensure!(
            unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == 0,
            "SERVICE_ACCOUNT_RESTRICTION_UNAVAILABLE"
        );
        image.verify()?;
        ensure!(
            image.sha256() == expected_image_sha256,
            "SERVICE_NATIVE_IMAGE_CHANGED"
        );
        let pid = std::process::id();
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        ensure!(raw >= 0, "SERVICE_PROCESS_IDENTITY_UNAVAILABLE");
        // SAFETY: pidfd_open returned this process's new owned kernel descriptor.
        let pidfd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
        let parent = unsafe { libc::getppid() };
        let parent_raw = unsafe { libc::syscall(libc::SYS_pidfd_open, parent, 0) };
        ensure!(
            parent_raw >= 0 && unsafe { libc::getppid() } == parent,
            "SERVICE_PROCESS_PARENT_CHANGED"
        );
        // SAFETY: the descriptor is for the actual current OS parent, not a JSON PID.
        let parent_pidfd = unsafe { OwnedFd::from_raw_fd(parent_raw as i32) };
        let process = Self {
            pidfd,
            parent_pidfd,
            pid,
            uid,
            image,
            _lease: lease,
        };
        process.verify()?;
        Ok(process)
    }
    #[cfg(not(target_os = "linux"))]
    pub fn capture_native_code(
        _native: &NativeIntegrationContext,
        _record: &NativeCodeServiceRecord,
        _storage: &NativeServiceLeases,
        _image: NativeServiceImage,
    ) -> Result<Self> {
        anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
    }
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn capture_scope_host(
        native: &NativeIntegrationContext,
        storage: &NativeServiceLeases,
        id: &str,
        spec: &kcoder_native_receipts::service_host_launch::OriginalScopeHostLaunch,
        descriptor: std::fs::File,
    ) -> Result<Self> {
        ensure!(spec.gateway_owned(), "APP_SERVER_HOST_GATEWAY_REQUIRED");
        native.validate_scope(&spec.scope)?;
        spec.verify_descriptor(native, storage, id, &descriptor)?;
        let image = NativeServiceImage::capture(&tokio_util::sync::CancellationToken::new())?;
        #[cfg(target_os = "macos")]
        {
            fs2::FileExt::try_lock_exclusive(&descriptor)?;
            Self::capture_owned_macos(
                &spec.native_image_sha256,
                image,
                NativeProcessLease::Infrastructure(descriptor),
            )
        }
        #[cfg(target_os = "linux")]
        {
            // The inherited open-file description must already be the actual
            // owner's lock; a separately opened contended slot fails here.
            fs2::FileExt::try_lock_exclusive(&descriptor)?;
            Self::capture_owned(
                &spec.native_image_sha256,
                image,
                NativeProcessLease::Infrastructure(descriptor),
            )
        }
        #[cfg(windows)]
        {
            // The Gateway launches each Node child in its own private Job.
            Self::capture_owned_windows(
                &spec.native_image_sha256,
                image,
                NativeProcessLease::Infrastructure(descriptor),
                true,
            )
        }
    }
    #[cfg(unix)]
    pub fn duplicate_scope_host_fence(&self) -> Result<std::fs::File> {
        self.verify()?;
        let NativeProcessLease::Infrastructure(file) = &self._lease else {
            anyhow::bail!("CHANNEL_HOST_ORIGINAL_DESCRIPTOR_REQUIRED")
        };
        Ok(file.try_clone()?)
    }
    #[cfg(windows)]
    pub fn verify_original_ui_peer(
        &self,
        peer: &super::windows_pipe::PipePeerIdentity,
    ) -> Result<()> {
        use std::os::windows::io::AsHandle;
        self.verify()?;
        let job = self
            .windows
            .scope_job
            .as_ref()
            .context("CHANNEL_HOST_ORIGINAL_SCOPE_JOB_REQUIRED")?;
        peer.verify_external_scope_ui(job, self.windows.parent.as_handle())
    }
    #[cfg(windows)]
    pub fn verify_scope_child_job(
        &self,
        process: std::os::windows::io::BorrowedHandle<'_>,
    ) -> Result<()> {
        self.verify()?;
        self.windows
            .scope_job
            .as_ref()
            .context("CHANNEL_HOST_ORIGINAL_SCOPE_JOB_REQUIRED")?
            .verify_process(process)
    }
    pub fn verify_scope_host_descriptor(
        &self,
        native: &NativeIntegrationContext,
        storage: &NativeServiceLeases,
        id: &str,
        spec: &kcoder_native_receipts::service_host_launch::OriginalScopeHostLaunch,
    ) -> Result<()> {
        self.verify()?;
        let NativeProcessLease::Infrastructure(file) = &self._lease else {
            anyhow::bail!("CHANNEL_HOST_ORIGINAL_DESCRIPTOR_REQUIRED")
        };
        #[cfg(unix)]
        fs2::FileExt::try_lock_exclusive(file)
            .context("CHANNEL_HOST_ORIGINAL_EXCLUSIVE_FENCE_REQUIRED")?;
        spec.verify_descriptor(native, storage, id, file)
    }
    pub fn verify(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            ensure!(
                std::process::id() == self.pid
                    && unsafe { libc::getuid() } == self.macos.0
                    && unsafe { libc::geteuid() } == self.macos.0,
                "SERVICE_PROCESS_OWNER_CHANGED"
            );
            ensure!(self.macos.1.alive()?, "SERVICE_PROCESS_PARENT_ENDED");
            self.image.verify()
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            ensure!(
                std::process::id() == self.pid
                    && unsafe { libc::getuid() } == self.uid
                    && unsafe { libc::geteuid() } == self.uid
                    && unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } == 1,
                "SERVICE_PROCESS_OWNER_CHANGED"
            );
            let mut poll = libc::pollfd {
                fd: self.pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            ensure!(
                unsafe { libc::poll(&mut poll, 1, 0) } == 0,
                "SERVICE_PROCESS_OWNER_CHANGED"
            );
            let mut parent = libc::pollfd {
                fd: self.parent_pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            ensure!(
                unsafe { libc::poll(&mut parent, 1, 0) } == 0,
                "SERVICE_PROCESS_PARENT_ENDED"
            );
            self.image.verify()
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsHandle;
            if let Some(job) = &self.windows.scope_job {
                job.verify_process(self.windows.process.as_handle())?;
            }
            ensure!(
                std::process::id() == self.pid,
                "SERVICE_PROCESS_OWNER_CHANGED"
            );
            self.windows
                .account
                .verify_owned_process(self.windows.process.as_handle())?;
            self.windows
                .account
                .verify_owned_process(self.windows.parent.as_handle())?;
            self.windows
                .parent_image
                .verify(self.windows.parent.as_handle())?;
            self.image.verify()
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
    }
    #[cfg(windows)]
    pub fn windows_parent(&self) -> Result<std::os::windows::io::BorrowedHandle<'_>> {
        use std::os::windows::io::AsHandle;
        self.verify()?;
        Ok(self.windows.parent.as_handle())
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn scope_host_accepts_current_account_and_retains_exclusive_lease() -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        kcoder_config::PrivateDirectory::open_or_create(&profile)?;
        kcoder_config::PrivateDirectory::open_or_create(&workspace)?;
        let native = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "account-lease-fixture",
            "account-lease-fixture",
        )?;
        let owner = crate::scope_host::NativeScopeHostBootstrap::open_gateway(
            native.recapture_for_owned_service()?,
        )?;
        owner.verify()?;
        let peer = crate::scope_host::NativeScopeHostBootstrap::open_gateway(
            native.recapture_for_owned_service()?,
        );
        assert_eq!(
            peer.unwrap_err().to_string(),
            "APP_SERVER_HOST_ORIGINAL_OWNER_BUSY"
        );
        owner.verify()?;
        drop(owner);
        let next = crate::scope_host::NativeScopeHostBootstrap::open_gateway(native)?;
        next.verify()?;
        Ok(())
    }
}

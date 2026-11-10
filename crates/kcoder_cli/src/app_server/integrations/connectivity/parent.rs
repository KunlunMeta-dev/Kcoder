//! Private parent capabilities originate from an actual owned child, never JSON labels.
use anyhow::{Context, Result, ensure};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::integrations::core::IntegrationScope;
use tokio::process::Child;

pub struct NativeConnectivityParent {
    pub id: String,
    pub scope: IntegrationScope,
    #[cfg(any(test, feature = "test-oracle", windows))]
    pub pid: u32,
    process: KernelProcess,
    tree: NativeConnectivityExitProof,
    scope_host: std::sync::OnceLock<std::sync::Arc<crate::scope_host::NativeScopeHostBootstrap>>,
}

pub enum NativeConnectivityExitProof {
    #[cfg(target_os = "linux")]
    SupervisedStdio(kcoder_process_supervisor::linux_stdio::StdioExitHandle),
    #[cfg(target_os = "macos")]
    DarwinStdio(kcoder_process_supervisor::macos::ProcessHandle),
    #[cfg(windows)]
    PrivateJob(kcoder_process_supervisor::suspended_child::JobExitHandle),
    #[cfg(any(test, feature = "test-oracle"))]
    OwnedNoDescendantsFixture,
}

impl std::fmt::Debug for NativeConnectivityParent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeConnectivityParent { owned_kernel_process: captured }")
    }
}

impl NativeConnectivityParent {
    /// The native supervisor retains Child ownership and its platform Job/stdio owner.
    pub fn capture(
        context: &NativeIntegrationContext,
        child: &mut Child,
        tree: NativeConnectivityExitProof,
    ) -> Result<Self> {
        context.verify()?;
        ensure!(child.try_wait()?.is_none(), "CONNECTIVITY_PARENT_EXITED");
        let pid = child.id().context("CONNECTIVITY_PARENT_UNAVAILABLE")?;
        let process = KernelProcess::capture(child, pid)?;
        #[cfg(target_os = "linux")]
        match &tree {
            NativeConnectivityExitProof::SupervisedStdio(exit) => {
                use std::os::fd::AsRawFd;
                let info =
                    std::fs::read_to_string(format!("/proc/self/fdinfo/{}", exit.as_raw_fd()))?;
                let original = info
                    .lines()
                    .find_map(|line| line.strip_prefix("Pid:\t"))
                    .context("CONNECTIVITY_OWNER_TREE_UNAVAILABLE")?
                    .parse::<u32>()?;
                ensure!(original == pid, "CONNECTIVITY_OWNER_TREE_MISMATCH");
            }
            #[cfg(any(test, feature = "test-oracle"))]
            NativeConnectivityExitProof::OwnedNoDescendantsFixture => {}
        }
        ensure!(process.alive()?, "CONNECTIVITY_PARENT_EXITED");
        context.verify()?;
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            scope: context.scope().clone(),
            #[cfg(any(test, feature = "test-oracle", windows))]
            pid,
            process,
            tree,
            scope_host: Default::default(),
        })
    }
    pub fn bind_scope_host(
        &self,
        context: &NativeIntegrationContext,
        host: std::sync::Arc<crate::scope_host::NativeScopeHostBootstrap>,
    ) -> Result<()> {
        self.verify(context)?;
        host.verify()?;
        context.validate_scope(host.native().scope())?;
        #[cfg(windows)]
        host.verify_scope_child_job(self.process.borrowed_handle())?;
        self.scope_host
            .set(host)
            .map_err(|_| anyhow::anyhow!("SCOPE_ORIGINAL_OWNER_ALREADY_BOUND"))
    }
    pub fn verify_scope_owner_process(&self, context: &NativeIntegrationContext) -> Result<()> {
        self.verify(context)
    }
    pub fn scope_original_tree_alive(&self) -> Result<bool> {
        self.alive()
    }
    pub fn scope_host(
        &self,
    ) -> Option<std::sync::Arc<crate::scope_host::NativeScopeHostBootstrap>> {
        self.scope_host.get().cloned()
    }
    pub fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.verify()?;
        self.check_process_for_captured_scope(context)
    }
    /// Transport identity only. Business actions must check current authority.
    pub fn check_process_for_captured_scope(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<()> {
        context.check_captured_scope(&self.scope)?;
        ensure!(self.process.alive()?, "CONNECTIVITY_PARENT_EXITED");
        Ok(())
    }
    /// Cleanup checks this actual shared process without borrowing any peer's
    /// execution authority. The caller must still drop only its exact resources.
    pub fn verify_cleanup(&self, context: &NativeIntegrationContext) -> Result<()> {
        ensure!(
            context.scope() == &self.scope && self.process.alive()?,
            "CONNECTIVITY_CLEANUP_OWNER_CHANGED"
        );
        Ok(())
    }
    pub fn alive(&self) -> Result<bool> {
        if self.process.alive()? {
            return Ok(true);
        }
        match &self.tree {
            #[cfg(target_os = "linux")]
            NativeConnectivityExitProof::SupervisedStdio(exit) => {
                use std::os::fd::AsRawFd;
                let mut value = libc::pollfd {
                    fd: exit.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let observed = unsafe { libc::poll(&mut value, 1, 0) };
                ensure!(
                    observed >= 0 && value.revents & libc::POLLNVAL == 0,
                    "CONNECTIVITY_OWNER_TREE_UNAVAILABLE"
                );
                Ok(observed == 0)
            }
            #[cfg(windows)]
            NativeConnectivityExitProof::PrivateJob(exit) => Ok(!exit.is_empty()?),
            #[cfg(target_os = "macos")]
            NativeConnectivityExitProof::DarwinStdio(exit) => exit.alive(),
            #[cfg(any(test, feature = "test-oracle"))]
            NativeConnectivityExitProof::OwnedNoDescendantsFixture => Ok(false),
            #[cfg(all(not(test), not(any(target_os = "linux", target_os = "macos", windows))))]
            _ => anyhow::bail!("CONNECTIVITY_NATIVE_SUPERVISOR_UNAVAILABLE"),
        }
    }
}

#[cfg(target_os = "linux")]
struct KernelProcess(std::os::fd::OwnedFd);
#[cfg(target_os = "linux")]
impl KernelProcess {
    fn capture(_: &Child, pid: u32) -> Result<Self> {
        use std::os::fd::FromRawFd;
        // SAFETY: pidfd_open returns a new owned descriptor for this actual Child.
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        ensure!(descriptor >= 0, "CONNECTIVITY_PIDFD_UNAVAILABLE");
        Ok(Self(unsafe {
            std::os::fd::OwnedFd::from_raw_fd(descriptor as i32)
        }))
    }
    fn alive(&self) -> Result<bool> {
        use std::os::fd::AsRawFd;
        let mut descriptor = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid owned descriptor and a valid output pollfd are supplied.
        let observed = unsafe { libc::poll(&mut descriptor, 1, 0) };
        ensure!(
            observed >= 0 && descriptor.revents & libc::POLLNVAL == 0,
            "CONNECTIVITY_PROCESS_OBSERVATION_UNAVAILABLE"
        );
        Ok(observed == 0)
    }
}

#[cfg(windows)]
struct KernelProcess(std::os::windows::io::OwnedHandle);
#[cfg(windows)]
impl KernelProcess {
    fn borrowed_handle(&self) -> std::os::windows::io::BorrowedHandle<'_> {
        use std::os::windows::io::AsHandle;
        self.0.as_handle()
    }
    fn capture(child: &Child, pid: u32) -> Result<Self> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessId};
        let original = child
            .raw_handle()
            .context("CONNECTIVITY_PROCESS_HANDLE_UNAVAILABLE")?;
        ensure!(
            unsafe { GetProcessId(original.cast()) } == pid,
            "CONNECTIVITY_PROCESS_IDENTITY_CHANGED"
        );
        let mut copied = std::ptr::null_mut();
        // SAFETY: the real Child owns original; the duplicate is non-inheritable.
        ensure!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    original.cast(),
                    GetCurrentProcess(),
                    &mut copied,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            } != 0,
            "CONNECTIVITY_PROCESS_HANDLE_UNAVAILABLE"
        );
        Ok(Self(unsafe {
            std::os::windows::io::OwnedHandle::from_raw_handle(copied.cast())
        }))
    }
    fn alive(&self) -> Result<bool> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let state = unsafe { WaitForSingleObject(self.0.as_raw_handle().cast(), 0) };
        ensure!(
            matches!(state, WAIT_OBJECT_0 | WAIT_TIMEOUT),
            "CONNECTIVITY_PROCESS_OBSERVATION_UNAVAILABLE"
        );
        Ok(state == WAIT_TIMEOUT)
    }
}

#[cfg(target_os = "macos")]
struct KernelProcess(kcoder_process_supervisor::macos::ProcessHandle);
#[cfg(target_os = "macos")]
impl KernelProcess {
    fn capture(_: &Child, pid: u32) -> Result<Self> {
        Ok(Self(
            kcoder_process_supervisor::macos::ProcessHandle::capture(pid)?,
        ))
    }
    fn alive(&self) -> Result<bool> {
        self.0.alive()
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
struct KernelProcess;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
impl KernelProcess {
    fn capture(_: &Child, _: u32) -> Result<Self> {
        anyhow::bail!("CONNECTIVITY_PROCESS_AUTHORITY_UNAVAILABLE")
    }
    fn alive(&self) -> Result<bool> {
        anyhow::bail!("CONNECTIVITY_PROCESS_AUTHORITY_UNAVAILABLE")
    }
}

//! Reuse the native command owner/Job for one fixed Office component process.
use super::*;
use tokio::process::Child;

pub(super) struct OwnedOfficeNodeProcess {
    pub(super) child: Child,
    #[cfg(target_os = "linux")]
    owner: kcoder_process_supervisor::linux_stdio::StdioOwnerGuard,
    #[cfg(windows)]
    job: kcoder_process_supervisor::suspended_child::SuspendedChildJob,
}
impl OwnedOfficeNodeProcess {
    pub(super) async fn spawn(
        node: &Path,
        entry: &Path,
        package: &Path,
        native: &NativeOfficeNodeLaunch,
    ) -> Result<Self> {
        #[cfg(not(any(target_os = "linux", windows)))]
        anyhow::bail!("OFFICE_COMPONENT_UNAVAILABLE");
        #[cfg(any(target_os = "linux", windows))]
        {
            #[cfg(target_os = "linux")]
            let mut command = Command::new(&native.owner_program);
            #[cfg(target_os = "linux")]
            command
                .arg(kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_V1)
                .arg(std::process::id().to_string())
                .arg(node);
            #[cfg(windows)]
            let mut command = Command::new(office_node_launch_path(node));
            configure_office_node_command(&mut command, entry, package, native.mode);
            command.kill_on_drop(false);
            #[cfg(windows)]
            let mut job = {
                command.creation_flags(
                    kcoder_process_supervisor::suspended_child::SUSPENDED_CHILD_FLAGS,
                );
                kcoder_process_supervisor::suspended_child::SuspendedChildJob::new()
                    .context("OFFICE_CLEANUP_UNCONFIRMED")?
            };
            let mut child = command.spawn().context("OFFICE_COMPONENT_UNAVAILABLE")?;
            #[cfg(target_os = "linux")]
            let owner = match kcoder_process_supervisor::linux_stdio::StdioOwnerGuard::for_child(
                child.id().context("OFFICE_PROCESS_PROTOCOL")?,
            ) {
                Ok(owner) => owner,
                Err(_) => {
                    if let Some(pid) = child.id() {
                        // SAFETY: this is our fresh unreaped child, so its PID cannot be reused.
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                            libc::kill(pid as i32, libc::SIGCONT);
                        }
                    }
                    tokio::time::timeout(std::time::Duration::from_secs(4), child.wait())
                        .await
                        .context("OFFICE_CLEANUP_UNCONFIRMED")?
                        .context("OFFICE_CLEANUP_UNCONFIRMED")?;
                    anyhow::bail!("OFFICE_CLEANUP_UNCONFIRMED");
                }
            };
            #[cfg(windows)]
            if (|| -> Result<()> {
                let handle = child.raw_handle().context("OFFICE_PROCESS_PROTOCOL")?;
                // SAFETY: the freshly spawned suspended child owns this live process handle.
                job.assign_and_resume(unsafe {
                    std::os::windows::io::BorrowedHandle::borrow_raw(handle)
                })?;
                Ok(())
            })()
            .is_err()
            {
                let _ = child.start_kill();
                tokio::time::timeout(std::time::Duration::from_secs(4), child.wait())
                    .await
                    .context("OFFICE_CLEANUP_UNCONFIRMED")?
                    .context("OFFICE_CLEANUP_UNCONFIRMED")?;
                anyhow::bail!("OFFICE_CLEANUP_UNCONFIRMED");
            }
            Ok(Self {
                child,
                #[cfg(target_os = "linux")]
                owner,
                #[cfg(windows)]
                job,
            })
        }
    }
    pub(super) async fn terminate(&mut self) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.owner.request_stop();
        #[cfg(windows)]
        self.job.terminate().context("OFFICE_CLEANUP_UNCONFIRMED")?;
        tokio::time::timeout(std::time::Duration::from_secs(4), self.child.wait())
            .await
            .context("OFFICE_CLEANUP_UNCONFIRMED")?
            .context("OFFICE_CLEANUP_UNCONFIRMED")?;
        #[cfg(windows)]
        {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(4);
            while !self
                .job
                .exit_handle()
                .is_empty()
                .context("OFFICE_CLEANUP_UNCONFIRMED")?
            {
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "OFFICE_CLEANUP_UNCONFIRMED"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        Ok(())
    }
}

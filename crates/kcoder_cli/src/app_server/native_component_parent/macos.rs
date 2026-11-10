//! Local Darwin component authority; this does not enable retained receipt migration.
use super::*;
use anyhow::{Context, ensure};
use kcoder_process_supervisor::macos::ProcessHandle;
use std::{mem::size_of, path::PathBuf};

pub(in super::super) struct MacosComponentParent {
    parent: ProcessHandle,
    parent_pid: u32,
    uid: u32,
    account: PrivateDirectory,
    account_path: PathBuf,
    account_identity: String,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    workspace_identity: String,
    workspace_digest: String,
}

impl MacosComponentParent {
    pub(in super::super) fn capture(
        configuration: &super::super::retention_context::RetentionLaunchConfiguration,
        engine: &kcoder_engine::QueryEngine,
    ) -> Result<Self> {
        ensure!(
            matches!(
                configuration.parent,
                kcoder_app_protocol::RetentionParentLaunchV1::LocalOs
            ),
            "NATIVE_MACOS_LOCAL_PARENT_REQUIRED"
        );
        for fd in [libc::STDIN_FILENO, libc::STDOUT_FILENO] {
            let mut info: libc::stat = unsafe { std::mem::zeroed() };
            ensure!(
                unsafe { libc::fstat(fd, &mut info) } == 0
                    && matches!(info.st_mode & libc::S_IFMT, libc::S_IFIFO | libc::S_IFSOCK),
                "NATIVE_MACOS_STDIO_PIPE_REQUIRED"
            );
        }
        let parent_pid = unsafe { libc::getppid() } as u32;
        let parent = ProcessHandle::capture(parent_pid)?;
        let uid = unsafe { libc::getuid() };
        let account = PrivateDirectory::open_existing(&configuration.account_root)?;
        account.verify_private_directory()?;
        let workspace_path = engine
            .state
            .cwd()
            .canonicalize()
            .context("NATIVE_MACOS_WORKSPACE_UNAVAILABLE")?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        let account_identity = account.directory_identity()?;
        let workspace_identity = workspace.directory_identity()?;
        let workspace_digest = super::super::private_files::hex_sha256(&serde_json::to_vec(&(
            "kcoder.native.component.macos.v1",
            uid,
            &account_identity,
            &workspace_path,
            &workspace_identity,
        ))?);
        let authority = Self {
            parent,
            parent_pid,
            uid,
            account,
            account_path: configuration.account_root.clone(),
            account_identity,
            workspace,
            workspace_path,
            workspace_identity,
            workspace_digest,
        };
        authority.verify()?;
        Ok(authority)
    }

    fn verify(&self) -> Result<()> {
        ensure!(
            self.parent.alive()? && unsafe { libc::getppid() } as u32 == self.parent_pid,
            "NATIVE_MACOS_PARENT_EXITED"
        );
        // libc supplies Darwin's ABI. No shell/PID-file identity or caller-provided UID is trusted.
        let mut parent: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let bytes = unsafe {
            libc::proc_pidinfo(
                self.parent_pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut parent as *mut libc::proc_bsdinfo).cast(),
                size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        ensure!(
            bytes as usize == size_of::<libc::proc_bsdinfo>()
                && parent.pbi_pid == self.parent_pid
                && self.uid != 0
                && unsafe { libc::getuid() } == self.uid
                && unsafe { libc::geteuid() } == self.uid
                && parent.pbi_uid == self.uid
                && parent.pbi_ruid == self.uid
                && unsafe { libc::getgid() } == unsafe { libc::getegid() }
                && parent.pbi_gid == unsafe { libc::getgid() },
            "NATIVE_MACOS_PARENT_IDENTITY_MISMATCH"
        );
        self.account.verify_private_directory()?;
        ensure!(
            self.account.directory_identity()? == self.account_identity
                && PrivateDirectory::open_existing(&self.account_path)?.directory_identity()?
                    == self.account_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace_identity,
            "NATIVE_MACOS_ROOT_IDENTITY_CHANGED"
        );
        Ok(())
    }
}

impl NativeComponentParentAuthority for MacosComponentParent {
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)> {
        self.verify()?;
        Ok((
            &self.workspace_digest,
            kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
        ))
    }

    fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        self.verify()?;
        ensure!(
            profile.directory_identity()? == self.account_identity
                && workspace.directory_identity()? == self.workspace_identity,
            "NATIVE_MACOS_COMPONENT_ROOT_MISMATCH"
        );
        Ok(())
    }
}

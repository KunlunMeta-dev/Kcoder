//! Actual local Windows SID/parent process and held directory identities.
use super::*;
use anyhow::{Context, ensure};
use kcoder_host_transport::native_component_parent::{actual_parent_pid, process_start};
use std::{
    os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
};
use windows_sys::Win32::{
    Foundation::{INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType},
    System::{
        Console::{GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        Threading::{
            GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    },
};
pub(in super::super) struct WindowsComponentParent {
    parent: OwnedHandle,
    sid: Vec<u8>,
    parent_start: u64,
    account: PrivateDirectory,
    account_path: PathBuf,
    account_identity: String,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    workspace_identity: String,
    workspace_digest: String,
}
impl WindowsComponentParent {
    pub(in super::super) fn capture(
        configuration: &super::super::retention_context::RetentionLaunchConfiguration,
        engine: &kcoder_engine::QueryEngine,
    ) -> Result<Self> {
        ensure!(
            matches!(
                configuration.parent,
                kcoder_app_protocol::RetentionParentLaunchV1::LocalOs
            ),
            "NATIVE_WINDOWS_LOCAL_PARENT_REQUIRED"
        );
        verify_stdio()?;
        let sid = process_sid(unsafe { GetCurrentProcess() })?;
        let parent_pid = actual_parent_pid()?;
        // SAFETY: this only opens the OS-reported current parent for query/liveness.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                parent_pid,
            )
        };
        ensure!(!raw.is_null(), "NATIVE_WINDOWS_PARENT_UNAVAILABLE");
        // SAFETY: OpenProcess returned a new non-inherited process handle.
        let parent = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        let parent_start = process_start(parent.as_raw_handle().cast())?;
        ensure!(
            parent_start <= process_start(unsafe { GetCurrentProcess() })?
                && process_sid(parent.as_raw_handle().cast())? == sid,
            "NATIVE_WINDOWS_PARENT_IDENTITY_MISMATCH"
        );
        let account = PrivateDirectory::open_existing(&configuration.account_root)?;
        account.verify_private_directory()?;
        let workspace_path = engine
            .state
            .cwd()
            .canonicalize()
            .context("NATIVE_WINDOWS_WORKSPACE_UNAVAILABLE")?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        let workspace_digest = root_digest(
            &sid,
            &account.directory_identity()?,
            &workspace_path,
            &workspace.directory_identity()?,
        )?;
        let value = Self {
            parent,
            sid,
            parent_start,
            account_path: configuration.account_root.clone(),
            account_identity: account.directory_identity()?,
            account,
            workspace_path,
            workspace_identity: workspace.directory_identity()?,
            workspace_digest,
            workspace,
        };
        value.verify()?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        let parent = self.parent.as_raw_handle().cast();
        // SAFETY: the held original process handle is valid and the wait is nonblocking.
        ensure!(
            unsafe { WaitForSingleObject(parent, 0) } == WAIT_TIMEOUT,
            "NATIVE_WINDOWS_PARENT_EXITED"
        );
        ensure!(
            process_start(parent)? == self.parent_start
                && process_sid(parent)? == self.sid
                && process_sid(unsafe { GetCurrentProcess() })? == self.sid,
            "NATIVE_WINDOWS_PARENT_IDENTITY_MISMATCH"
        );
        self.account.verify_private_directory()?;
        ensure!(
            self.account.directory_identity()? == self.account_identity
                && PrivateDirectory::open_existing(&self.account_path)?.directory_identity()?
                    == self.account_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace_identity,
            "NATIVE_WINDOWS_ROOT_IDENTITY_CHANGED"
        );
        Ok(())
    }
}
impl NativeComponentParentAuthority for WindowsComponentParent {
    fn verified_windows_parent_process(&self) -> Result<std::os::windows::io::BorrowedHandle<'_>> {
        self.verify()?;
        Ok(self.parent.as_handle())
    }
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
            "NATIVE_WINDOWS_COMPONENT_ROOT_MISMATCH"
        );
        Ok(())
    }
}
pub(in super::super) struct WindowsRootIds {
    pub(in super::super) profile_identity: String,
    pub(in super::super) workspace_identity: String,
    pub(in super::super) workspace_digest: String,
}
pub(in super::super) fn windows_roots(
    engine: &kcoder_engine::QueryEngine,
) -> Result<WindowsRootIds> {
    let path = engine
        .settings_persistence_path()
        .context("NATIVE_WINDOWS_PROFILE_UNAVAILABLE")?;
    let profile = PrivateDirectory::open_existing(
        path.parent()
            .context("NATIVE_WINDOWS_PROFILE_UNAVAILABLE")?,
    )?;
    profile.verify_private_directory()?;
    let workspace_path = engine.state.cwd().canonicalize()?;
    let workspace = PrivateDirectory::open_existing(&workspace_path)?;
    let profile_identity = profile.directory_identity()?;
    let workspace_identity = workspace.directory_identity()?;
    let sid = process_sid(unsafe { GetCurrentProcess() })?;
    let workspace_digest = root_digest(
        &sid,
        &profile_identity,
        &workspace_path,
        &workspace_identity,
    )?;
    Ok(WindowsRootIds {
        profile_identity,
        workspace_identity,
        workspace_digest,
    })
}
fn root_digest(
    sid: &[u8],
    profile: &str,
    workspace: &std::path::Path,
    identity: &str,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "kcoder.native.component.windows.v1",
            sid,
            profile,
            workspace,
            identity
        ))?)
    ))
}
fn verify_stdio() -> Result<()> {
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE] {
        // SAFETY: these are the process's existing stdio handles; ownership is not transferred.
        let handle = unsafe { GetStdHandle(which) };
        ensure!(
            !handle.is_null()
                && handle != INVALID_HANDLE_VALUE
                && unsafe { GetFileType(handle) } == FILE_TYPE_PIPE,
            "NATIVE_WINDOWS_STDIO_PIPE_REQUIRED"
        );
    }
    Ok(())
}
pub(in super::super) use kcoder_native_scope::service_identity::process_sid;

pub(in super::super) use kcoder_host_transport::native_component_parent::capture_current_service_parent;

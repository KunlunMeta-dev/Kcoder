//! A held child-process observation, independent of task or transport authority.
use super::image::ImageLease;
use anyhow::{Context, Result, ensure};
use std::{
    ffi::OsString,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::PathBuf,
};
use windows_sys::Win32::{
    Foundation::{
        CompareObjectHandles, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_TOKEN, FILETIME, GetLastError,
        INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
    },
    Security::{GetLengthSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        SystemInformation::GetSystemDirectoryW,
        Threading::{
            GetCurrentProcess, GetCurrentProcessId, GetCurrentThread, GetProcessId,
            GetProcessTimes, OpenProcess, OpenProcessToken, OpenThreadToken,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        },
    },
};

pub(super) struct ProcessLease {
    process: OwnedHandle,
    pid: u32,
    creation: u64,
    parent_token: OwnedHandle,
    child_token: OwnedHandle,
}

pub(super) fn system_ssh_path() -> Result<PathBuf> {
    let mut path = vec![0u16; 32768];
    // SAFETY: this asks the OS for its system directory, independent of environment/PATH.
    let length = unsafe { GetSystemDirectoryW(path.as_mut_ptr(), path.len() as u32) } as usize;
    ensure!(
        length > 0 && length < path.len(),
        "NATIVE_SYSTEM_DIRECTORY_UNAVAILABLE"
    );
    Ok(PathBuf::from(OsString::from_wide(&path[..length]))
        .join("OpenSSH")
        .join("ssh.exe"))
}

impl ProcessLease {
    /// The trusted launcher calls synchronously while its original ProcessWrap
    /// still owns the process. The PID locates an object once; it is never reused
    /// as authority or reopened on subsequent observations.
    pub(super) fn capture(image: &ImageLease, pid: u32) -> Result<Self> {
        no_impersonation()?;
        ensure!(
            pid != 0 && pid != unsafe { GetCurrentProcessId() },
            "NATIVE_PROCESS_CHILD_REQUIRED"
        );
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        ensure!(!raw.is_null(), "NATIVE_PROCESS_UNAVAILABLE");
        // SAFETY: OpenProcess returned a new owned handle with query/wait access.
        let process = unsafe { OwnedHandle::from_raw_handle(raw) };
        ensure!(
            parent_pid(pid)? == unsafe { GetCurrentProcessId() },
            "NATIVE_PROCESS_PARENT_CHANGED"
        );
        let creation = creation_time(process.as_raw_handle())?;
        ensure!(
            creation >= creation_time(unsafe { GetCurrentProcess() })?,
            "NATIVE_PROCESS_CREATION_INVALID"
        );
        let parent_token = primary_token(unsafe { GetCurrentProcess() })?;
        let child_token = primary_token(process.as_raw_handle())?;
        ensure!(
            token_sid(parent_token.as_raw_handle())? == token_sid(child_token.as_raw_handle())?,
            "NATIVE_PROCESS_ACCOUNT_CHANGED"
        );
        let lease = Self {
            process,
            pid,
            creation,
            parent_token,
            child_token,
        };
        lease.verify(image)?;
        Ok(lease)
    }

    pub(super) fn verify(&self, image: &ImageLease) -> Result<()> {
        no_impersonation()?;
        let raw = self.process.as_raw_handle();
        ensure!(
            unsafe { WaitForSingleObject(raw, 0) } == WAIT_TIMEOUT,
            "NATIVE_PROCESS_EXITED"
        );
        ensure!(
            unsafe { GetProcessId(raw) } == self.pid && creation_time(raw)? == self.creation,
            "NATIVE_PROCESS_IDENTITY_CHANGED"
        );
        self.verify_tokens()?;
        ensure!(
            image.matches(&image_path(raw)?)?,
            "NATIVE_PROCESS_IMAGE_CHANGED"
        );
        no_impersonation()?;
        self.verify_tokens()?;
        ensure!(
            unsafe { WaitForSingleObject(raw, 0) } == WAIT_TIMEOUT,
            "NATIVE_PROCESS_EXITED"
        );
        Ok(())
    }

    fn verify_tokens(&self) -> Result<()> {
        let parent = primary_token(unsafe { GetCurrentProcess() })?;
        let child = primary_token(self.process.as_raw_handle())?;
        // Same SID is insufficient: token replacement retires this observation.
        ensure!(
            unsafe {
                CompareObjectHandles(parent.as_raw_handle(), self.parent_token.as_raw_handle())
            } != 0
                && unsafe {
                    CompareObjectHandles(child.as_raw_handle(), self.child_token.as_raw_handle())
                } != 0,
            "NATIVE_PROCESS_ACCOUNT_CHANGED"
        );
        Ok(())
    }
}

fn creation_time(process: *mut std::ffi::c_void) -> Result<u64> {
    let (mut created, mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) =
        unsafe { zeroed() };
    // SAFETY: the retained process handle grants query access; outputs have the API layout.
    ensure!(
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } != 0,
        "NATIVE_PROCESS_TIMES_UNAVAILABLE"
    );
    let value = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    ensure!(value != 0, "NATIVE_PROCESS_CREATION_INVALID");
    Ok(value)
}

fn image_path(process: *mut std::ffi::c_void) -> Result<PathBuf> {
    // This is the held process, not a reopened PID.
    kcoder_native_image_identity::process_image_path(process)
        .context("NATIVE_PROCESS_IMAGE_UNAVAILABLE")
}

fn parent_pid(pid: u32) -> Result<u32> {
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    ensure!(
        raw != INVALID_HANDLE_VALUE,
        "NATIVE_PROCESS_PARENT_UNAVAILABLE"
    );
    // SAFETY: the snapshot returned a new valid handle, owned only by this observer.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut available = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
    for _ in 0..16384 {
        if !available {
            break;
        }
        if entry.th32ProcessID == pid {
            return Ok(entry.th32ParentProcessID);
        }
        available = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    anyhow::bail!("NATIVE_PROCESS_PARENT_UNAVAILABLE")
}

fn no_impersonation() -> Result<()> {
    let mut token = std::ptr::null_mut();
    let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
    if opened != 0 {
        // SAFETY: success returned a new thread token; close it before rejecting.
        let _owned = unsafe { OwnedHandle::from_raw_handle(token) };
        anyhow::bail!("NATIVE_PROCESS_IMPERSONATION_REJECTED");
    }
    ensure!(
        unsafe { GetLastError() } == ERROR_NO_TOKEN,
        "NATIVE_PROCESS_ACCOUNT_UNAVAILABLE"
    );
    Ok(())
}

fn primary_token(process: *mut std::ffi::c_void) -> Result<OwnedHandle> {
    let mut raw = std::ptr::null_mut();
    ensure!(
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } != 0,
        "NATIVE_PROCESS_ACCOUNT_UNAVAILABLE"
    );
    // SAFETY: success returned a new primary-token handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn token_sid(token: *mut std::ffi::c_void) -> Result<Vec<u8>> {
    let mut needed = 0;
    ensure!(
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed,) }
            == 0
            && unsafe { GetLastError() } == ERROR_INSUFFICIENT_BUFFER
            && (size_of::<TOKEN_USER>()..=65536).contains(&(needed as usize)),
        "NATIVE_PROCESS_ACCOUNT_UNAVAILABLE"
    );
    let words = (needed as usize).div_ceil(size_of::<usize>());
    let mut buffer = vec![0usize; words];
    ensure!(
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } != 0,
        "NATIVE_PROCESS_ACCOUNT_UNAVAILABLE"
    );
    // SAFETY: the buffer is aligned and holds at least one complete TOKEN_USER.
    let info = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let start = buffer.as_ptr() as usize;
    let end = start
        .checked_add(buffer.len() * size_of::<usize>())
        .context("NATIVE_PROCESS_ACCOUNT_INVALID")?;
    let sid = info.User.Sid as usize;
    ensure!(
        sid >= start && sid.checked_add(8).is_some_and(|value| value <= end),
        "NATIVE_PROCESS_ACCOUNT_INVALID"
    );
    ensure!(
        unsafe { IsValidSid(info.User.Sid) } != 0,
        "NATIVE_PROCESS_ACCOUNT_INVALID"
    );
    let length = unsafe { GetLengthSid(info.User.Sid) } as usize;
    ensure!(
        (8..=68).contains(&length) && sid.checked_add(length).is_some_and(|value| value <= end),
        "NATIVE_PROCESS_ACCOUNT_INVALID"
    );
    // SAFETY: the validated SID is completely contained in the owned token buffer.
    Ok(unsafe { std::slice::from_raw_parts(info.User.Sid.cast::<u8>(), length) }.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct Fixture {
        image: ImageLease,
        child: Child,
        directory: tempfile::TempDir,
        hash: String,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let directory = tempfile::tempdir()?;
            let bytes = std::fs::read(std::env::current_exe()?)?;
            let path = directory.path().join("owned-process-child.exe");
            std::fs::write(&path, &bytes)?;
            let hash = format!("{:x}", Sha256::digest(bytes));
            let image = ImageLease::capture(&path, &hash, false)?;
            let child = Command::new(&path)
                .args([
                    "--ignored",
                    "--exact",
                    "native_image::process::tests::owned_process_child",
                ])
                .env_clear()
                .env("KCODER_NATIVE_PROCESS_TEST_CHILD", "1")
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            Ok(Self {
                image,
                child,
                directory,
                hash,
            })
        }
        fn finish(&mut self) -> Result<()> {
            self.child.stdin.take();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = self.child.try_wait()? {
                    ensure!(status.success(), "owned child failed");
                    return Ok(());
                }
                ensure!(Instant::now() < deadline, "owned child did not exit");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    #[ignore = "Owned child fixture; invoked only by its parent test"]
    fn owned_process_child() {
        if std::env::var("KCODER_NATIVE_PROCESS_TEST_CHILD").as_deref() != Ok("1") {
            return;
        }
        let mut byte = [0u8];
        let _ = std::io::stdin().read(&mut byte);
    }

    #[test]
    fn process_observation_holds_original_child_and_rejects_exit() -> Result<()> {
        let mut fixture = Fixture::new()?;
        let lease = ProcessLease::capture(&fixture.image, fixture.child.id())?;
        lease.verify(&fixture.image)?;
        fixture.finish()?;
        ensure!(
            lease.verify(&fixture.image).is_err(),
            "exited process remained current"
        );
        Ok(())
    }

    #[test]
    fn process_observation_requires_child_and_actual_image_object() -> Result<()> {
        let mut fixture = Fixture::new()?;
        ensure!(
            ProcessLease::capture(&fixture.image, unsafe { GetCurrentProcessId() }).is_err(),
            "self accepted as child"
        );
        let other = fixture.directory.path().join("different-image.exe");
        std::fs::copy(
            fixture.directory.path().join("owned-process-child.exe"),
            &other,
        )?;
        let other_image = ImageLease::capture(&other, &fixture.hash, false)?;
        ensure!(
            ProcessLease::capture(&other_image, fixture.child.id()).is_err(),
            "same bytes substituted for actual image"
        );
        let lease = ProcessLease::capture(&fixture.image, fixture.child.id())?;
        drop(lease);
        ensure!(
            fixture.child.try_wait()?.is_none(),
            "closing a fact lease terminated its child"
        );
        fixture.finish()?;
        Ok(())
    }

    #[test]
    fn process_observation_rejects_even_same_account_thread_impersonation() -> Result<()> {
        use windows_sys::Win32::Security::{ImpersonateSelf, RevertToSelf, SecurityImpersonation};
        let fixture = Fixture::new()?;
        let lease = ProcessLease::capture(&fixture.image, fixture.child.id())?;
        ensure!(
            unsafe { ImpersonateSelf(SecurityImpersonation) } != 0,
            "could not enter owned impersonation test"
        );
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe {
                    RevertToSelf();
                }
            }
        }
        let restore = Restore;
        ensure!(
            lease.verify(&fixture.image).is_err(),
            "impersonation accepted as original primary account"
        );
        drop(restore);
        lease.verify(&fixture.image)?;
        Ok(())
    }
}

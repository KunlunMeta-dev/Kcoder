//! OS-derived identity checks for a connected local named pipe. This is one
//! layer of admission: the host must also check its registered client capability.
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, GetLastError, HANDLE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenSessionId, TokenUser},
    System::{
        Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
        Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_DUP_HANDLE,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW,
            WaitForSingleObject,
        },
    },
};

#[derive(Debug, PartialEq, Eq)]
pub enum PeerError {
    System(u32),
    InvalidToken,
    DifferentUser,
    DifferentSession,
}

/// Own the process handle until the connection is closed; do not authenticate
/// by a PID supplied in a request or keep only a recyclable numeric PID.
pub struct VerifiedPeer {
    process: OwnedHandle,
    pub process_id: u32,
    pub session_id: u32,
}

impl VerifiedPeer {
    /// Verify the image belonging to the retained OS process, not a path claimed
    /// in its handshake. A recovery peer must run the same pinned host binary.
    pub fn executable_matches(&self, expected: &std::path::Path) -> Result<bool, PeerError> {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(
                self.process.as_raw_handle(),
                0,
                buffer.as_mut_ptr(),
                &mut length,
            )
        } == 0
        {
            return Err(last_error());
        }
        if length == 0 || length as usize > buffer.len() {
            return Err(PeerError::InvalidToken);
        }
        let actual =
            std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
        let actual = std::fs::canonicalize(actual).map_err(|_| PeerError::InvalidToken)?;
        let expected = std::fs::canonicalize(expected).map_err(|_| PeerError::InvalidToken)?;
        let actual: Vec<u16> = actual.as_os_str().encode_wide().collect();
        let expected: Vec<u16> = expected.as_os_str().encode_wide().collect();
        Ok(unsafe {
            windows_sys::Win32::Globalization::CompareStringOrdinal(
                actual.as_ptr(),
                actual.len() as i32,
                expected.as_ptr(),
                expected.len() as i32,
                1,
            )
        } == windows_sys::Win32::Globalization::CSTR_EQUAL)
    }
    pub fn is_alive(&self) -> Result<bool, PeerError> {
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(false),
            WAIT_TIMEOUT => Ok(true),
            _ => Err(last_error()),
        }
    }

    pub(crate) fn duplicate_into(
        &self,
        handle: BorrowedHandle<'_>,
        access: u32,
    ) -> Result<usize, PeerError> {
        let mut transferred = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle.as_raw_handle(),
                self.process.as_raw_handle(),
                &mut transferred,
                access,
                0,
                0,
            )
        } == 0
        {
            return Err(last_error());
        }
        Ok(transferred as usize)
    }

    /// Only undo a duplicate that has NOT been sent to the peer. Once a frame
    /// may have arrived, only the receiving process owns these handle values.
    pub(crate) fn undo_unsent_duplicate(&self, value: usize) {
        let mut local = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                self.process.as_raw_handle(),
                value as HANDLE,
                GetCurrentProcess(),
                &mut local,
                0,
                0,
                DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS,
            )
        } != 0
        {
            drop(unsafe { OwnedHandle::from_raw_handle(local) });
        }
    }
    /// Poll the retained kernel object, never a recycled numeric PID. No blocking
    /// wait thread is left behind if connection shutdown cancels this future.
    pub async fn wait_for_exit(&self) -> Result<(), PeerError> {
        loop {
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => return Ok(()),
                WAIT_TIMEOUT => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                _ => return Err(last_error()),
            }
        }
    }
}

pub enum PipePeer {
    Client,
    Server,
}

pub fn verify_pipe_peer(
    pipe: BorrowedHandle<'_>,
    peer: PipePeer,
) -> Result<VerifiedPeer, PeerError> {
    verify_peer(pipe, peer, 0)
}

/// Use only after deciding this registered peer is the recovery recipient.
/// Ordinary broker clients never receive duplicate-handle access.
pub fn verify_recovery_peer(
    pipe: BorrowedHandle<'_>,
    peer: PipePeer,
) -> Result<VerifiedPeer, PeerError> {
    verify_peer(pipe, peer, PROCESS_DUP_HANDLE)
}

fn verify_peer(
    pipe: BorrowedHandle<'_>,
    peer: PipePeer,
    extra_access: u32,
) -> Result<VerifiedPeer, PeerError> {
    let mut pid = 0;
    let ok = unsafe {
        match peer {
            PipePeer::Client => GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid),
            PipePeer::Server => GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid),
        }
    };
    if ok == 0 {
        return Err(last_error());
    }
    if pid == 0 {
        return Err(PeerError::InvalidToken);
    }
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | extra_access,
            0,
            pid,
        )
    };
    if process.is_null() {
        return Err(last_error());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let remote = token(process.as_raw_handle())?;
    let local = token(unsafe { GetCurrentProcess() })?;
    let session_id = session(&remote)?;
    if session_id == 0 || session_id != session(&local)? {
        return Err(PeerError::DifferentSession);
    }
    let remote_user = user(&remote)?;
    let local_user = user(&local)?;
    let same = unsafe {
        let remote = &*remote_user.as_ptr().cast::<TOKEN_USER>();
        let local = &*local_user.as_ptr().cast::<TOKEN_USER>();
        EqualSid(remote.User.Sid, local.User.Sid) != 0
    };
    if !same {
        return Err(PeerError::DifferentUser);
    }
    Ok(VerifiedPeer {
        process,
        process_id: pid,
        session_id,
    })
}

fn last_error() -> PeerError {
    PeerError::System(unsafe { GetLastError() })
}
fn token(process: HANDLE) -> Result<OwnedHandle, PeerError> {
    let mut handle = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut handle) } == 0 {
        return Err(last_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
fn session(token: &OwnedHandle) -> Result<u32, PeerError> {
    let mut session = 0u32;
    let mut length = 0;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenSessionId,
            (&mut session as *mut u32).cast(),
            4,
            &mut length,
        )
    } == 0
    {
        return Err(last_error());
    }
    if length != 4 {
        return Err(PeerError::InvalidToken);
    }
    Ok(session)
}
fn user(token: &OwnedHandle) -> Result<Vec<usize>, PeerError> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut length,
        );
    }
    if length < std::mem::size_of::<TOKEN_USER>() as u32 || length > 65536 {
        return Err(PeerError::InvalidToken);
    }
    // usize storage provides the alignment required by TOKEN_USER and SID pointers.
    let mut storage = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    let capacity = (storage.len() * std::mem::size_of::<usize>()) as u32;
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            capacity,
            &mut length,
        )
    } == 0
    {
        return Err(last_error());
    }
    if length > capacity {
        return Err(PeerError::InvalidToken);
    }
    Ok(storage)
}

/// Current process token SID for the pipe's explicit user-only DACL.
pub(crate) fn current_user_sid() -> Result<String, PeerError> {
    use windows_sys::Win32::{
        Foundation::LocalFree, Security::Authorization::ConvertSidToStringSidW,
    };
    let current = token(unsafe { GetCurrentProcess() })?;
    let info = user(&current)?;
    let sid = unsafe { (&*info.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(last_error());
    }
    let result = unsafe {
        let mut length = 0;
        while length < 256 && *text.add(length) != 0 {
            length += 1;
        }
        if length == 256 {
            Err(PeerError::InvalidToken)
        } else {
            String::from_utf16(std::slice::from_raw_parts(text, length))
                .map_err(|_| PeerError::InvalidToken)
        }
    };
    unsafe {
        LocalFree(text.cast());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::Duration,
    };

    #[tokio::test]
    async fn retained_process_handle_signals_exit_without_waiting_for_pipe_eof() {
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 20",
            ])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                child.id(),
            )
        };
        if handle.is_null() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("cannot open owned test child");
        }
        let peer = VerifiedPeer {
            process: unsafe { OwnedHandle::from_raw_handle(handle) },
            process_id: child.id(),
            session_id: 0,
        };
        let alive = tokio::time::timeout(Duration::from_millis(20), peer.wait_for_exit()).await;
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(alive.is_err(), "a live process must not signal exit");
        tokio::time::timeout(Duration::from_secs(1), peer.wait_for_exit())
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn cleanup_handoff_duplicates_only_query_and_terminate_job_rights() {
        use crate::windows_process::{CleanupJob, JobChild};
        use windows_sys::Win32::System::{
            JobObjects::{
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject,
            },
            RemoteDesktop::ProcessIdToSessionId,
            Threading::GetCurrentProcessId,
        };
        let mut session_id = 0;
        assert_ne!(
            unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) },
            0
        );
        let handle = unsafe {
            OpenProcess(
                PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                GetCurrentProcessId(),
            )
        };
        assert!(!handle.is_null());
        // Only this test substitutes a current-process recipient. Production
        // peers are constructed by the named-pipe SID/session admission path.
        let peer = VerifiedPeer {
            process: unsafe { OwnedHandle::from_raw_handle(handle) },
            process_id: std::process::id(),
            session_id,
        };
        let directory = tempfile::tempdir().unwrap();
        let system = std::env::var_os("SystemRoot").unwrap();
        let mut command = Command::new(
            std::path::PathBuf::from(&system)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command
            .current_dir(directory.path())
            .env_clear()
            .env("SystemRoot", system)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Threading.Thread]::Sleep(20000)",
            ]);
        let worker = JobChild::spawn(&command).unwrap();
        let (job, process) = worker.transfer_cleanup_to(&peer).unwrap();
        let mut cleanup = CleanupJob::from_owned_handles(
            unsafe { OwnedHandle::from_raw_handle(job as usize as HANDLE) },
            unsafe { OwnedHandle::from_raw_handle(process as usize as HANDLE) },
            session_id,
        )
        .unwrap();
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    cleanup.handle().as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let policy_write = unsafe {
            SetInformationJobObject(
                cleanup.handle().as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        drop(worker);
        cleanup.terminate_and_wait(Duration::from_secs(5)).unwrap();
        assert_eq!(
            policy_write, 0,
            "recovery must not receive Job policy mutation rights"
        );
    }
}

//! Local current-SID pipes authenticate actual process/image handles before JSON.
use super::{
    windows_account::{
        CurrentWindowsPeerAccount, CurrentWindowsServiceAccount, WindowsPeerTokenWitness,
    },
    windows_image::WindowsServiceImage,
};
use anyhow::{Context, Result, ensure};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::{
        ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
        ERROR_PIPE_NOT_CONNECTED, GetLastError, INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX, ReadFile},
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, PIPE_NOWAIT, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PeekNamedPipe, SetNamedPipeHandleState,
        },
        Threading::{
            GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    },
};

pub struct ServicePipeServer {
    file: File,
    account: CurrentWindowsServiceAccount,
}
pub struct ServicePipe {
    file: File,
    identity: identity::PipePeerIdentity,
}
// This selector is constructed only by the matching kernel-backed entry point.
// Ordinary service pipes keep their original non-elevated account contract.
enum PipeAccount {
    Service(CurrentWindowsServiceAccount),
    PeerSource(CurrentWindowsPeerAccount),
}
impl PipeAccount {
    fn service() -> Result<Self> {
        Ok(Self::Service(CurrentWindowsServiceAccount::capture()?))
    }
    fn peer_source() -> Result<Self> {
        Ok(Self::PeerSource(CurrentWindowsPeerAccount::capture()?))
    }
    fn verify(&self) -> Result<()> {
        match self {
            Self::Service(a) => a.verify(),
            Self::PeerSource(a) => a.verify(),
        }
    }
    fn duplicate(&self) -> Result<Self> {
        match self {
            Self::Service(a) => a.duplicate().map(Self::Service),
            Self::PeerSource(a) => a.duplicate().map(Self::PeerSource),
        }
    }
    fn sid_string(&self) -> Result<String> {
        match self {
            Self::Service(a) => a.sid_string(),
            Self::PeerSource(a) => a.sid_string(),
        }
    }
    fn verify_owned_process(&self, process: BorrowedHandle<'_>) -> Result<()> {
        match self {
            Self::Service(a) => a.verify_owned_process(process),
            Self::PeerSource(a) => a.capture_process(process).map(|_| ()),
        }
    }
}
impl ServicePipeServer {
    pub fn bind(name: &str) -> Result<Self> {
        validate_name(name)?;
        let account = CurrentWindowsServiceAccount::capture()?;
        let descriptor = Descriptor::current(&account)?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let wide = wide(name);
        let raw = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                16384,
                16384,
                0,
                &mut attributes,
            )
        };
        ensure!(
            raw != INVALID_HANDLE_VALUE,
            "SERVICE_WINDOWS_PIPE_BIND_UNAVAILABLE"
        );
        let file = unsafe { File::from_raw_handle(raw.cast()) };
        account.verify()?;
        Ok(Self { file, account })
    }
    pub fn accept(&self, image_sha: &str) -> Result<Option<ServicePipe>> {
        self.account.verify()?;
        let connected =
            unsafe { ConnectNamedPipe(self.file.as_raw_handle().cast(), std::ptr::null_mut()) };
        if connected == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_PIPE_LISTENING {
                return Ok(None);
            }
            if matches!(error, ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED) {
                // A peer may close its own attempt before this accept poll.
                // Retire only that stale connection; the scope owner and every
                // already admitted stream remain owned by the existing host.
                self.disconnect()?;
                return Ok(None);
            }
            ensure!(
                error == ERROR_PIPE_CONNECTED,
                "SERVICE_WINDOWS_PIPE_CONNECT_UNAVAILABLE"
            );
        }
        match ServicePipe::capture(self.file.try_clone()?, true, image_sha) {
            Ok(pipe) => Ok(Some(pipe)),
            Err(_) => {
                // Rejection belongs to this attempted connection. Keep the
                // original manager and every already owned scope worker alive.
                self.disconnect()?;
                Ok(None)
            }
        }
    }
    pub fn disconnect(&self) -> Result<()> {
        ensure!(
            unsafe { DisconnectNamedPipe(self.file.as_raw_handle().cast()) } != 0
                || unsafe { GetLastError() } == ERROR_PIPE_NOT_CONNECTED,
            "SERVICE_WINDOWS_PIPE_DISCONNECT_UNAVAILABLE"
        );
        Ok(())
    }
}
impl ServicePipe {
    /// Only peer-source carriers use the actual current account's permission
    /// tier. This does not enable an elevated personal service or another pipe purpose.
    pub fn connect_peer_source_same_image(
        name: &str,
        image: &WindowsServiceImage,
    ) -> Result<Option<Self>> {
        validate_peer_source_name(name)?;
        Self::connect_same_image_with_account(name, image, PipeAccount::peer_source()?)
    }
    /// A source IPC lookup verifies the exact load-bound native image without
    /// rescanning its bytes. Missing/busy are not permission to start a worker.
    pub fn connect_existing_same_image(
        name: &str,
        image: &WindowsServiceImage,
    ) -> Result<Option<Self>> {
        Self::connect_same_image_with_account(name, image, PipeAccount::service()?)
    }
    fn connect_same_image_with_account(
        name: &str,
        image: &WindowsServiceImage,
        account: PipeAccount,
    ) -> Result<Option<Self>> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
        };
        validate_name(name)?;
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
            .open(name)
        {
            Ok(file) => file,
            Err(error) if error.raw_os_error() == Some(2) => return Ok(None),
            Err(error) => return Err(error).context("SERVICE_WINDOWS_PIPE_CONNECT_UNCONFIRMED"),
        };
        let mode = PIPE_NOWAIT | PIPE_READMODE_BYTE;
        ensure!(
            unsafe {
                SetNamedPipeHandleState(
                    file.as_raw_handle().cast(),
                    &mode,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            } != 0,
            "SERVICE_WINDOWS_PIPE_MODE_UNAVAILABLE"
        );
        let identity = identity::PipePeerIdentity::capture_same_image_account(
            file.as_raw_handle(),
            false,
            image,
            account,
        )?;
        Ok(Some(Self { file, identity }))
    }
    pub fn connect(name: &str, image_sha: &str, budget: Duration) -> Result<Self> {
        validate_name(name)?;
        let until = Instant::now() + budget;
        loop {
            match OpenOptions::new().read(true).write(true).open(name) {
                Ok(file) => return Self::capture(file, false, image_sha),
                Err(error)
                    if matches!(error.raw_os_error(), Some(2 | 231)) && Instant::now() < until =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => anyhow::bail!("SERVICE_WINDOWS_PIPE_UNAVAILABLE"),
            }
        }
    }
    fn capture(file: File, server: bool, image_sha: &str) -> Result<Self> {
        let mode = PIPE_NOWAIT | PIPE_READMODE_BYTE;
        ensure!(
            unsafe {
                SetNamedPipeHandleState(
                    file.as_raw_handle().cast(),
                    &mode,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            } != 0,
            "SERVICE_WINDOWS_PIPE_MODE_UNAVAILABLE"
        );
        let identity =
            identity::PipePeerIdentity::capture(file.as_raw_handle(), server, image_sha)?;
        Ok(Self { file, identity })
    }
    pub fn verify(&self) -> Result<()> {
        self.identity.verify()
    }
    pub fn require_process(&self, original: BorrowedHandle<'_>) -> Result<()> {
        self.identity.require_process(original)
    }
    pub fn read(&mut self, budget: Duration, maximum: usize) -> Result<serde_json::Value> {
        ensure!(
            (1..=self.identity.maximum_frame()).contains(&maximum),
            "SERVICE_WINDOWS_PIPE_BOUND_INVALID"
        );
        if self.identity.is_peer_source() {
            return self.read_peer_source(budget, maximum);
        }
        let until = Instant::now() + budget;
        let mut bytes = Vec::new();
        loop {
            self.verify()?;
            if Instant::now() >= until {
                eprintln!(
                    "{}",
                    serde_json::json!({"event":"native_scope_original_pipe_unconfirmed","stage":"read_deadline","bytesRead":bytes.len()})
                );
                anyhow::bail!("SERVICE_WINDOWS_PIPE_REPLY_UNCONFIRMED");
            }
            let mut byte = [0u8; 1];
            // std::fs::File may collapse Windows pipe errors into EOF. Keep the
            // kernel result so an empty PIPE_NOWAIT read is distinct from closure.
            let mut count = 0;
            let result = unsafe {
                ReadFile(
                    self.file.as_raw_handle().cast(),
                    byte.as_mut_ptr().cast(),
                    1,
                    &mut count,
                    std::ptr::null_mut(),
                )
            };
            let read = if result != 0 {
                Ok(count)
            } else {
                Err(std::io::Error::last_os_error())
            };
            match read {
                Ok(1) => {
                    if byte[0] == b'\n' {
                        break;
                    }
                    ensure!(
                        bytes.len() < maximum,
                        "SERVICE_WINDOWS_PIPE_FRAME_TOO_LARGE"
                    );
                    bytes.push(byte[0]);
                }
                Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({"event":"native_scope_original_pipe_unconfirmed","stage":"read_error","bytesRead":bytes.len(),"osError":error.raw_os_error()})
                    );
                    anyhow::bail!("SERVICE_WINDOWS_PIPE_REPLY_UNCONFIRMED");
                }
                Ok(_) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({"event":"native_scope_original_pipe_unconfirmed","stage":"read_eof","bytesRead":bytes.len()})
                    );
                    anyhow::bail!("SERVICE_WINDOWS_PIPE_REPLY_UNCONFIRMED");
                }
            }
        }
        self.verify()?;
        serde_json::from_slice(&bytes).context("SERVICE_WINDOWS_PIPE_FRAME_INVALID")
    }
    pub fn write(&mut self, value: &serde_json::Value) -> Result<()> {
        self.verify()?;
        let mut bytes = serde_json::to_vec(value)?;
        let payload_limit =
            self.identity.maximum_frame() - usize::from(self.identity.is_peer_source());
        ensure!(
            bytes.len() <= payload_limit,
            "SERVICE_WINDOWS_PIPE_FRAME_TOO_LARGE"
        );
        bytes.push(b'\n');
        if self.identity.is_peer_source() {
            return self.write_peer_source(&bytes);
        }
        self.file
            .write_all(&bytes)
            .context("SERVICE_WINDOWS_PIPE_WRITE_UNCONFIRMED")?;
        self.verify()
    }
    /// The reader closes only this connection after its original response read.
    /// Observing that closure avoids discarding unread output without a blocking
    /// FlushFileBuffers or a new application-level acknowledgement protocol.
    pub fn wait_peer_closed(&self, budget: Duration) -> Result<()> {
        let until = Instant::now() + budget;
        loop {
            self.verify()?;
            let mut available = 0;
            let result = unsafe {
                PeekNamedPipe(
                    self.file.as_raw_handle().cast(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if result == 0 {
                let error = unsafe { GetLastError() };
                ensure!(
                    matches!(error, ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED),
                    "SERVICE_WINDOWS_PIPE_CLOSE_UNCONFIRMED"
                );
                return Ok(());
            }
            ensure!(
                available == 0 && Instant::now() < until,
                "SERVICE_WINDOWS_PIPE_CLOSE_UNCONFIRMED"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn into_file(self) -> File {
        self.file
    }
}
struct Descriptor(*mut std::ffi::c_void);
impl Descriptor {
    fn current(account: &CurrentWindowsServiceAccount) -> Result<Self> {
        Self::for_sid(&account.sid_string()?)
    }
    fn for_account(account: &PipeAccount) -> Result<Self> {
        Self::for_sid(&account.sid_string()?)
    }
    fn for_sid(sid: &str) -> Result<Self> {
        let text = wide(&format!("D:P(A;;GA;;;{sid})"));
        let mut value = std::ptr::null_mut();
        ensure!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    SDDL_REVISION_1,
                    &mut value,
                    std::ptr::null_mut(),
                )
            } != 0,
            "SERVICE_WINDOWS_PIPE_DACL_UNAVAILABLE"
        );
        Ok(Self(value))
    }
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn validate_name(name: &str) -> Result<()> {
    let suffix = name
        .strip_prefix(r"\\.\pipe\kcoder-service-v1-")
        .context("SERVICE_WINDOWS_PIPE_NAME_INVALID")?;
    ensure!(
        name.len() <= 240
            && !suffix.is_empty()
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "SERVICE_WINDOWS_PIPE_NAME_INVALID"
    );
    Ok(())
}
fn validate_peer_source_name(name: &str) -> Result<()> {
    let digest = name
        .strip_prefix(r"\\.\pipe\kcoder-service-v1-peer-source-")
        .context("PEER_SOURCE_WINDOWS_PIPE_PURPOSE_DENIED")?;
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "PEER_SOURCE_WINDOWS_PIPE_PURPOSE_DENIED"
    );
    Ok(())
}
fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[path = "windows_pipe/asynchronous.rs"]
pub mod asynchronous;
#[path = "windows_pipe/identity.rs"]
pub mod identity;
pub use identity::PipePeerIdentity;

#[path = "windows_pipe/peer_io.rs"]
mod peer_io;

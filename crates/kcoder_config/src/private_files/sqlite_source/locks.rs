//! SQLite lock offsets are its native file protocol, not fs2/flock coordination.
use std::{fs::File, io, sync::Arc};

pub(super) struct RangeLease {
    file: Arc<File>,
    start: u64,
    length: u64,
}
impl RangeLease {
    pub(super) fn try_acquire(
        file: &Arc<File>,
        start: u64,
        length: u64,
        exclusive: bool,
    ) -> io::Result<Option<Self>> {
        let file = Arc::clone(file);
        match acquire(&file, start, length, exclusive) {
            Ok(()) => Ok(Some(Self {
                file,
                start,
                length,
            })),
            Err(error) if busy(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
impl Drop for RangeLease {
    fn drop(&mut self) {
        let _ = release(&self.file, self.start, self.length);
    }
}

#[cfg(target_os = "linux")]
fn operation(file: &File, start: u64, length: u64, kind: libc::c_short) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: flock is a plain C record; the verified descriptor remains live throughout fcntl.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = kind;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    lock.l_start = start
        .try_into()
        .map_err(|_| io::Error::other("sqlite lock offset"))?;
    lock.l_len = length
        .try_into()
        .map_err(|_| io::Error::other("sqlite lock length"))?;
    // OFD locks conflict with SQLite POSIX locks even in this process. Traditional F_SETLK
    // would merge this guard with unrelated SQLite descriptors owned by the same process.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_OFD_SETLK, &lock) } == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(target_os = "linux")]
fn acquire(file: &File, start: u64, length: u64, exclusive: bool) -> io::Result<()> {
    operation(
        file,
        start,
        length,
        if exclusive {
            libc::F_WRLCK
        } else {
            libc::F_RDLCK
        } as libc::c_short,
    )
}
#[cfg(target_os = "linux")]
fn release(file: &File, start: u64, length: u64) -> io::Result<()> {
    operation(file, start, length, libc::F_UNLCK as libc::c_short)
}
#[cfg(target_os = "linux")]
fn busy(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::EACCES | libc::EAGAIN))
}

#[cfg(windows)]
fn operation(file: &File, start: u64, length: u64, flags: Option<u32>) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Storage::FileSystem::{LockFileEx, UnlockFileEx},
        System::IO::OVERLAPPED,
    };
    // SAFETY: no asynchronous file operation or event is requested.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.Anonymous.Anonymous.Offset = start as u32;
    overlapped.Anonymous.Anonymous.OffsetHigh = (start >> 32) as u32;
    // SAFETY: the owned live handle and stack OVERLAPPED outlive this synchronous call.
    let result = unsafe {
        match flags {
            Some(flags) => LockFileEx(
                file.as_raw_handle().cast(),
                flags,
                0,
                length as u32,
                (length >> 32) as u32,
                &mut overlapped,
            ),
            None => UnlockFileEx(
                file.as_raw_handle().cast(),
                0,
                length as u32,
                (length >> 32) as u32,
                &mut overlapped,
            ),
        }
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(windows)]
fn acquire(file: &File, start: u64, length: u64, exclusive: bool) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    operation(
        file,
        start,
        length,
        Some(
            LOCKFILE_FAIL_IMMEDIATELY
                | if exclusive {
                    LOCKFILE_EXCLUSIVE_LOCK
                } else {
                    0
                },
        ),
    )
}
#[cfg(windows)]
fn release(file: &File, start: u64, length: u64) -> io::Result<()> {
    operation(file, start, length, None)
}
#[cfg(windows)]
fn busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn acquire(_: &File, _: u64, _: u64, _: bool) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "source sqlite byte locks unsupported",
    ))
}
#[cfg(not(any(target_os = "linux", windows)))]
fn release(_: &File, _: u64, _: u64) -> io::Result<()> {
    Ok(())
}
#[cfg(not(any(target_os = "linux", windows)))]
fn busy(_: &io::Error) -> bool {
    false
}

//! Write only after the original owner has reaped every owned descendant.
use anyhow::{Result, ensure};
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::MetadataExt,
};

/// A private inherited descriptor retained by its original owning process.
/// The supervised target never inherits the writer descriptor.
pub struct OwnedCleanupReceipt {
    file: File,
    identity: (u64, u64),
    _directory: tempfile::TempDir,
}
impl OwnedCleanupReceipt {
    pub fn create() -> Result<Self> {
        Self::create_at(None)
    }
    /// The domain can keep unknown original receipts inside its existing
    /// private profile rather than an unowned global temporary namespace.
    pub fn create_in(parent: &std::path::Path) -> Result<Self> {
        Self::create_at(Some(parent))
    }
    fn create_at(parent: Option<&std::path::Path>) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut builder = tempfile::Builder::new();
        builder.prefix("kcoder-owned-cleanup-");
        let directory = match parent {
            Some(parent) => builder.tempdir_in(parent)?,
            None => builder.tempdir()?,
        };
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.path().join("receipt"))?;
        let info = file.metadata()?;
        ensure!(
            info.is_file()
                && info.nlink() == 1
                && info.uid() == unsafe { libc::geteuid() }
                && info.mode() & 0o777 == 0o600,
            "Unsafe owned cleanup receipt"
        );
        Ok(Self {
            identity: (info.dev(), info.ino()),
            file,
            _directory: directory,
        })
    }
    pub fn descriptor(&self) -> i32 {
        self.file.as_raw_fd()
    }
    /// This is only half of the proof. The caller must independently wait for
    /// the original owner process to exit before accepting these bytes.
    pub fn confirmed(&self) -> Result<bool> {
        use std::os::unix::fs::FileExt;
        let info = self.file.metadata()?;
        ensure!(
            info.is_file()
                && info.nlink() == 1
                && (info.dev(), info.ino()) == self.identity
                && info.uid() == unsafe { libc::geteuid() }
                && info.mode() & 0o777 == 0o600,
            "Owned cleanup receipt identity changed"
        );
        if info.len() != CLEANUP_CONFIRMED_BYTES.len() as u64 {
            return Ok(false);
        }
        let mut bytes = vec![0; CLEANUP_CONFIRMED_BYTES.len()];
        self.file.read_exact_at(&mut bytes, 0)?;
        Ok(bytes == CLEANUP_CONFIRMED_BYTES)
    }
}

pub const CLEANUP_CONFIRMED_BYTES: &[u8] = b"kcoder-owned-cleanup/v1\nconfirmed\n";
pub(super) struct Writer(File);
impl Writer {
    pub(super) fn from_inherited(fd: i32) -> Result<Self> {
        ensure!(fd > 2, "Invalid cleanup receipt descriptor");
        // SAFETY: this private entry takes ownership of the explicitly inherited descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.nlink() == 1
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o777 == 0o600
                && metadata.len() == 0,
            "Unsafe cleanup receipt descriptor"
        );
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        ensure!(
            flags >= 0 && flags & libc::O_ACCMODE != libc::O_RDONLY,
            "Cleanup receipt is not writable"
        );
        // Target code must never receive the completion-writing descriptor.
        ensure!(
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "Cannot isolate cleanup receipt descriptor"
        );
        Ok(Self(file))
    }
    pub(super) fn confirm(&mut self) -> Result<()> {
        self.0.seek(SeekFrom::Start(0))?;
        self.0.write_all(CLEANUP_CONFIRMED_BYTES)?;
        self.0.sync_all()?;
        Ok(())
    }
}

//! Advisory lock guards that release the lock itself, not only their handle.

use std::fs::File;
use std::ops::Deref;

/// A held advisory lock on a private lock leaf that is released when dropped.
///
/// On Unix an `flock` lock belongs to the open file description, not to the
/// descriptor. A child that another thread forks while the lock is held gets
/// a duplicate descriptor and keeps the lock until it execs: `O_CLOEXEC` only
/// closes the duplicate at exec, and posix_spawn/fork+exec both have that
/// window. Closing this process's descriptor alone therefore leaves the lock
/// held for a moment, and a sequential re-acquisition by the same process,
/// or any other participant, falsely reads as "busy". Dropping this guard
/// unlocks the shared description explicitly, which releases it for every
/// inherited duplicate. Such a child never owns the lock; it only carries the
/// descriptor until exec closes it.
///
/// Windows locks belong to the handle, and Rust opens handles
/// non-inheritable, so the explicit unlock is equivalent to the close there.
///
/// Use this guard for locks that this process owns for itself. A lease that
/// is intentionally handed to a child process must keep a plain `File`.
#[derive(Debug)]
pub struct PrivateFileLock {
    file: File,
}

impl PrivateFileLock {
    /// Adopt a lock handle on which this process has just acquired an
    /// advisory lock itself, so that dropping it releases that lock.
    pub fn from_locked(file: File) -> Self {
        Self { file }
    }

    /// Transfer the still-held lock to another owner that releases it itself.
    pub fn into_locked_file(self) -> File {
        let this = std::mem::ManuallyDrop::new(self);
        // SAFETY: `this` is never dropped, so the handle is moved out once.
        unsafe { std::ptr::read(&this.file) }
    }

    /// The locked lock-file handle, e.g. for identity checks.
    pub fn file(&self) -> &File {
        &self.file
    }
}

impl Deref for PrivateFileLock {
    type Target = File;

    fn deref(&self) -> &File {
        &self.file
    }
}

impl Drop for PrivateFileLock {
    fn drop(&mut self) {
        // Closing the handle still releases the lock once every inherited
        // duplicate has been closed, so a failed unlock only delays release.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

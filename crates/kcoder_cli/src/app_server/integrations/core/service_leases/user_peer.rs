//! An OS peer identity is not public control, background consent or a tool grant.
use anyhow::{Context, Result, ensure};
use std::{
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::MetadataExt, net::UnixStream},
    },
};

/// Peer-denial causes are split so operators can tell an upgrade mismatch from
/// a different account or an exited process. Every code still rejects the peer;
/// none of them is a recoverable allow verdict.
///
/// The peer account differs from this service account.
pub const PEER_ACCOUNT_MISMATCH: &str = "NATIVE_CODE_MANAGER_PEER_ACCOUNT_MISMATCH";
/// The peer runs a different executable build (most commonly the manager kept
/// running the previous build after an upgrade), or its image was replaced or
/// modified in place while held. Recovery: restart KCoder Studio after the
/// upgrade so the client and its Native service manager run the same build.
pub const PEER_IMAGE_CHANGED: &str = "NATIVE_CODE_MANAGER_PEER_IMAGE_CHANGED";
/// The peer process exited after it connected.
pub const PEER_EXITED: &str = "NATIVE_CODE_MANAGER_PEER_EXITED";
/// The kernel or a seccomp policy refuses `pidfd_open`, so the peer process
/// cannot be held. This platform cannot provide the required process identity.
pub const PEER_PIDFD_UNSUPPORTED: &str = "NATIVE_CODE_MANAGER_PEER_PIDFD_UNSUPPORTED";
/// Generic denial: unreadable credentials, an invalid PID or an executable
/// outside the bounded regular-file contract. Older peers report only this code.
pub const PEER_DENIED: &str = "NATIVE_CODE_MANAGER_PEER_DENIED";

pub struct NativeUserServicePeer {
    pidfd: OwnedFd,
    pid: i32,
    image: File,
    identity: (u64, u64, u64),
}
impl NativeUserServicePeer {
    pub fn capture(stream: &UnixStream, expected_sha: &str) -> Result<Self> {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let read = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut size,
            )
        } == 0;
        check_credentials(
            read,
            credentials.uid,
            unsafe { libc::geteuid() },
            credentials.pid,
        )?;
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, credentials.pid, 0) };
        if raw < 0 {
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            anyhow::bail!(pidfd_open_failure(errno));
        }
        let pidfd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
        let mut image = File::open(format!("/proc/{}/exe", credentials.pid))?;
        let metadata = image.metadata()?;
        let identity = (metadata.dev(), metadata.ino(), metadata.len());
        check_image_metadata(metadata.is_file(), identity.2)?;
        // A verified self-image content digest is reusable only for this exact
        // opened peer inode. The digest is not an identity or authorization cache.
        let cached_sha256 = super::image::cached_content_sha256_for_peer_identity(identity)?;
        let sha256 = peer_content_sha256(&mut image, identity, cached_sha256)?;
        ensure!(sha256 == expected_sha, PEER_IMAGE_CHANGED);
        let peer = Self {
            pidfd,
            pid: credentials.pid,
            image,
            identity,
        };
        peer.verify()?;
        Ok(peer)
    }
    pub fn held_pid(&self) -> Result<u32> {
        self.verify()?;
        Ok(u32::try_from(self.pid)?)
    }
    pub fn verify(&self) -> Result<()> {
        let mut poll = libc::pollfd {
            fd: self.pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        check_pidfd_poll(unsafe { libc::poll(&mut poll, 1, 0) })?;
        let current = File::open(format!("/proc/{}/exe", self.pid))?.metadata()?;
        let held = self.image.metadata()?;
        // A different live image means exec/replacement; a changed held size
        // means in-place modification. Both retire this peer identity.
        ensure!(
            (current.dev(), current.ino(), current.len()) == self.identity
                && (held.dev(), held.ino(), held.len()) == self.identity,
            PEER_IMAGE_CHANGED
        );
        Ok(())
    }
    /// A managed task/SDK descendant cannot turn its native image into a UI
    /// producer. This is an extra origin fence, never a permission grant.
    pub fn is_in_process_tree(&self, original_root: u32) -> Result<bool> {
        self.verify()?;
        let mut current = u32::try_from(self.pid)?;
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..64 {
            if current == original_root {
                return Ok(true);
            }
            if current <= 1 {
                self.verify()?;
                return Ok(false);
            }
            ensure!(
                seen.insert(current),
                "NATIVE_CODE_MANAGER_PEER_ANCESTRY_UNAVAILABLE"
            );
            let stat = std::fs::read_to_string(format!("/proc/{current}/stat"))?;
            let (_, tail) = stat
                .rsplit_once(") ")
                .context("NATIVE_CODE_MANAGER_PEER_ANCESTRY_UNAVAILABLE")?;
            current = tail
                .split_whitespace()
                .nth(1)
                .context("NATIVE_CODE_MANAGER_PEER_ANCESTRY_UNAVAILABLE")?
                .parse()?;
        }
        anyhow::bail!("NATIVE_CODE_MANAGER_PEER_ANCESTRY_UNAVAILABLE")
    }
}

fn peer_content_sha256(
    image: &mut File,
    identity: (u64, u64, u64),
    cached_sha256: Option<String>,
) -> Result<String> {
    if let Some(sha256) = cached_sha256 {
        return Ok(sha256);
    }

    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let count = image.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total.checked_add(count as u64).context(PEER_DENIED)?;
        // Bytes beyond or short of the opened size mean the image changed
        // while it was being read; the partial digest is never accepted.
        ensure!(total <= identity.2, PEER_IMAGE_CHANGED);
        digest.update(&buffer[..count]);
    }
    ensure!(total == identity.2, PEER_IMAGE_CHANGED);
    Ok(digest
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn check_credentials(read: bool, peer_uid: u32, own_uid: u32, pid: i32) -> Result<()> {
    ensure!(read && pid > 0, PEER_DENIED);
    ensure!(peer_uid == own_uid, PEER_ACCOUNT_MISMATCH);
    Ok(())
}

fn pidfd_open_failure(errno: i32) -> &'static str {
    match errno {
        // The peer exited between SO_PEERCRED and pidfd_open.
        libc::ESRCH => PEER_EXITED,
        // Kernels before 5.3 lack the syscall; seccomp filters commonly
        // answer unknown syscalls with ENOSYS or EPERM.
        libc::ENOSYS | libc::EPERM => PEER_PIDFD_UNSUPPORTED,
        _ => PEER_DENIED,
    }
}

fn check_image_metadata(is_file: bool, bytes: u64) -> Result<()> {
    ensure!(
        is_file && (1..=1024 * 1024 * 1024).contains(&bytes),
        PEER_DENIED
    );
    Ok(())
}

fn check_pidfd_poll(observed: i32) -> Result<()> {
    // A readable pidfd means the held process exited; a failed poll proves
    // nothing about the peer and stays generic.
    ensure!(observed != 1, PEER_EXITED);
    ensure!(observed == 0, PEER_DENIED);
    Ok(())
}

#[cfg(all(target_os = "linux", test))]
#[path = "user_peer_tests.rs"]
mod tests;

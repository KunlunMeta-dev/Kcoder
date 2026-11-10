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
        ensure!(
            unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size,
                )
            } == 0
                && credentials.uid == unsafe { libc::geteuid() }
                && credentials.pid > 0,
            "NATIVE_CODE_MANAGER_PEER_DENIED"
        );
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, credentials.pid, 0) };
        ensure!(raw >= 0, "NATIVE_CODE_MANAGER_PEER_DENIED");
        let pidfd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
        let mut image = File::open(format!("/proc/{}/exe", credentials.pid))?;
        let metadata = image.metadata()?;
        let identity = (metadata.dev(), metadata.ino(), metadata.len());
        ensure!(
            metadata.is_file() && (1..=1024 * 1024 * 1024).contains(&identity.2),
            "NATIVE_CODE_MANAGER_PEER_DENIED"
        );
        // A verified self-image content digest is reusable only for this exact
        // opened peer inode. The digest is not an identity or authorization cache.
        let cached_sha256 = super::image::cached_content_sha256_for_peer_identity(identity)?;
        let sha256 = peer_content_sha256(&mut image, identity, cached_sha256)?;
        ensure!(sha256 == expected_sha, "NATIVE_CODE_MANAGER_PEER_DENIED");
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
        ensure!(
            unsafe { libc::poll(&mut poll, 1, 0) } == 0,
            "NATIVE_CODE_MANAGER_PEER_DENIED"
        );
        let current = File::open(format!("/proc/{}/exe", self.pid))?.metadata()?;
        let held = self.image.metadata()?;
        ensure!(
            (current.dev(), current.ino(), current.len()) == self.identity
                && (held.dev(), held.ino(), held.len()) == self.identity,
            "NATIVE_CODE_MANAGER_PEER_DENIED"
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
        total = total
            .checked_add(count as u64)
            .context("NATIVE_CODE_MANAGER_PEER_DENIED")?;
        ensure!(total <= identity.2, "NATIVE_CODE_MANAGER_PEER_DENIED");
        digest.update(&buffer[..count]);
    }
    ensure!(total == identity.2, "NATIVE_CODE_MANAGER_PEER_DENIED");
    Ok(digest
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(all(target_os = "linux", test))]
#[path = "user_peer_tests.rs"]
mod tests;

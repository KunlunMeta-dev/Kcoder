//! Private archive owner leases survive workers and permit safe abandoned-root cleanup.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::{PrivateDirectory, PrivateTempDir, create_private_temp_dir};
use std::{ffi::OsStr, fs::File, io::Read, path::Path};
const PREFIX: &str = "kcoder-wiki-archive-";
const MARKER: &[u8] = b"kcoder-wiki-archive-owner-v1";
const CLAIMED: &[u8] = b"kcoder-wiki-archive-cleanup-v1";

pub(super) struct ArchiveOwner {
    directory: Option<PrivateTempDir>,
    lease: Option<File>,
}
impl ArchiveOwner {
    pub(super) fn new() -> Result<Self> {
        let directory = create_private_temp_dir("kcoder-wiki-archive")?;
        let private = PrivateDirectory::open_existing(directory.path())?;
        let lease = private.open_read_write_file(OsStr::new(".lease"), true)?;
        lease.lock_exclusive()?;
        // A root is eligible for recovery only after its exclusive owner lease exists.
        private.atomic_replace(OsStr::new(".ready"), MARKER)?;
        Ok(Self {
            directory: Some(directory),
            lease: Some(lease),
        })
    }
    pub(super) fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("owner directory live")
            .path()
    }
}
impl Drop for ArchiveOwner {
    fn drop(&mut self) {
        // Close leaf handles before deleting on Windows. Cancelled-worker files have
        // already dropped before this owner; scanners also validate ready and lease.
        self.lease = None;
        self.directory = None;
    }
}
fn generated_name(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .and_then(|name| name.strip_prefix(PREFIX))
        .is_some_and(|nonce| {
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}
/// Each pass is bounded and only generated, ready roots with an unlocked lease are eligible.
pub(super) fn scavenge(parent: &Path) -> Result<usize> {
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    let mut removed = 0;
    for entry in entries.take(4096) {
        if removed == 16 {
            break;
        }
        let entry = entry?;
        let path = entry.path();
        if !generated_name(&path) || !entry.file_type()?.is_dir() {
            continue;
        }
        removed += usize::from(scavenge_owned_root(&path)?);
    }
    Ok(removed)
}
fn scavenge_owned_root(path: &Path) -> Result<bool> {
    ensure!(generated_name(path), "invalid archive owner namespace");
    let private = match PrivateDirectory::open_existing(path) {
        Ok(private) => private,
        Err(_) => return Ok(false),
    };
    let marker = match private.open_regular_file(OsStr::new(".ready")) {
        Ok(marker) => marker,
        Err(_) => return Ok(false),
    };
    let mut bytes = Vec::new();
    marker
        .take((MARKER.len().max(CLAIMED.len()) + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes != MARKER && bytes != CLAIMED {
        return Ok(false);
    }
    let lease = match private.open_read_write_file(OsStr::new(".lease"), false) {
        Ok(lease) => lease,
        Err(_) => return Ok(false),
    };
    match lease.try_lock_exclusive() {
        Ok(()) => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error.into()),
    }
    // A claimed root remains eligible if Windows cleanup temporarily fails. Its
    // lease still serializes scanners; repeated removal of this dead owner is safe.
    private.atomic_replace(OsStr::new(".ready"), CLAIMED)?;
    drop(lease);
    drop(private);
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error).context("abandoned Wiki archive cleanup failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[test]
    fn archive_owner_crash_child() -> Result<()> {
        let Some(output) = std::env::var_os("KCODER_ARCHIVE_CRASH_FIXTURE_OUT") else {
            return Ok(());
        };
        let owner = ArchiveOwner::new()?;
        std::fs::write(owner.path().join("owned-part"), b"partial snapshot")?;
        std::fs::write(output, owner.path().to_string_lossy().as_bytes())?;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    #[test]
    fn active_not_ready_and_sigkill_owner_cleanup_are_distinct() -> Result<()> {
        let owner = ArchiveOwner::new()?;
        let active = owner.path().to_path_buf();
        assert!(!scavenge_owned_root(&active)?);
        assert!(active.exists());
        let unready = create_private_temp_dir("kcoder-wiki-archive")?;
        assert!(!scavenge_owned_root(unready.path())?);
        let control = tempfile::tempdir()?;
        let output = control.path().join("root.txt");
        let child = std::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "app_server::knowledge_archive_owner::tests::archive_owner_crash_child",
                "--nocapture",
            ])
            .env("KCODER_ARCHIVE_CRASH_FIXTURE_OUT", &output)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        let mut child = ChildGuard(child);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !output.is_file() {
            if child.0.try_wait()?.is_some() {
                anyhow::bail!("archive lease child exited before readiness");
            }
            if std::time::Instant::now() > deadline {
                let _ = child.0.kill();
                let _ = child.0.wait();
                anyhow::bail!("archive lease child readiness timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let abandoned = PathBuf::from(std::fs::read_to_string(&output)?);
        assert!(!scavenge_owned_root(&abandoned)?);
        child.0.kill()?;
        let status = child.0.wait()?; // Authoritative process terminal before recovery.
        assert!(!status.success());
        assert!(scavenge_owned_root(&abandoned)?);
        assert!(!abandoned.exists());
        assert!(active.exists());
        assert!(unready.path().exists());
        drop(owner);
        assert!(!active.exists());
        Ok(())
    }
}

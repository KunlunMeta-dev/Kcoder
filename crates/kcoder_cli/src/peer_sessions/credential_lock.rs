//! Bounded credential mutation ownership; no namespace or permission repair.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, fs::File, time::Duration};

pub(super) struct CredentialMutationLease {
    file: File,
}
impl CredentialMutationLease {
    pub(super) fn from_locked(file: File) -> Self {
        Self { file }
    }
}
impl Drop for CredentialMutationLease {
    fn drop(&mut self) {
        // Closing one descriptor does not release an OFD lock retained by a
        // fork/dup. The completed mutation owner explicitly ends its lease.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}
pub(super) async fn acquire(
    profile: &PrivateDirectory,
    name: &OsStr,
) -> Result<CredentialMutationLease> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(lock) = profile.try_exclusive_lock(name)? {
            return Ok(CredentialMutationLease::from_locked(lock));
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "peer Gateway credentials busy"
        );
        // A real concurrent owner or fork-to-exec descriptor handoff must
        // finish before mutation starts. Contention never bypasses the lock.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    #[tokio::test]
    async fn completed_mutation_unlocks_its_original_open_description_while_a_duplicate_is_alive()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = PrivateDirectory::open_existing(root.path())?;
        let name = OsStr::new("owned-mutation.lock");
        let owner = acquire(&profile, name).await?;
        let duplicate = owner.file.try_clone()?;
        let metadata = owner.file.metadata()?;
        eprintln!(
            "credential lock proof pid={} owner_fd={} duplicate_fd={} device={} inode={}",
            std::process::id(),
            owner.file.as_raw_fd(),
            duplicate.as_raw_fd(),
            metadata.dev(),
            metadata.ino()
        );
        assert!(
            profile.try_exclusive_lock(name)?.is_none(),
            "a live owner still excludes another mutation"
        );
        drop(owner);
        let successor = profile.try_exclusive_lock(name)?;
        assert!(
            successor.is_some(),
            "a finished owner must release its lock even while an inherited/duplicated descriptor remains open"
        );
        drop(successor);
        drop(duplicate);
        Ok(())
    }
}

//! A stable per-session lock protects all private Git scratch repositories.
//! Keep the lock file outside repositories so removal cannot split the lock inode.
use anyhow::{Context, Result};
use std::{ffi::OsStr, fs::File, path::Path};

pub(super) fn active(parent: &Path) -> Result<File> {
    kcoder_config::PrivateDirectory::open_existing(parent)?
        .try_shared_lock(OsStr::new(".snapshot-repositories.lock"))?
        .context("snapshot cleanup is busy; cannot start snapshot")
}

pub(super) fn cleanup(parent: &Path) -> Result<Option<File>> {
    kcoder_config::PrivateDirectory::open_existing(parent)?
        .try_exclusive_lock(OsStr::new(".snapshot-repositories.lock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_snapshot_prevents_cleanup_until_its_last_owner_exits() {
        let temp = tempfile::tempdir().unwrap();
        let first = active(temp.path()).unwrap();
        let second = active(temp.path()).unwrap();
        assert!(cleanup(temp.path()).unwrap().is_none());
        drop(first);
        assert!(cleanup(temp.path()).unwrap().is_none());
        drop(second);
        let cleaning = cleanup(temp.path()).unwrap().unwrap();
        assert!(active(temp.path()).is_err());
        drop(cleaning);
        assert!(active(temp.path()).is_ok());
    }
}

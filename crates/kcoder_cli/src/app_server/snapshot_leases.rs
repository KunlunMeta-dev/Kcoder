//! A stable per-session lock protects all private Git scratch repositories.
//! Keep the lock file outside repositories so removal cannot split the lock inode.
use anyhow::{Context, Result};
use std::{ffi::OsStr, fs::File, path::Path};

pub fn active(parent: &Path) -> Result<File> {
    kcoder_config::PrivateDirectory::open_existing(parent)?
        .try_shared_lock(OsStr::new(".snapshot-repositories.lock"))?
        .context("snapshot cleanup is busy; cannot start snapshot")
}

/// Bounded wait for a transient holder of the cleanup lease. A child between fork and exec
/// shares the lock file description, so a cleanup this process just released can still look
/// held for a moment whenever another thread spawns a subprocess (Git, shells, MCP servers).
/// A real snapshot owner holds its shared lease for the whole turn and still reports busy.
const CLEANUP_TRANSIENT_HOLDER_WAIT: std::time::Duration = std::time::Duration::from_millis(250);

pub fn cleanup(parent: &Path) -> Result<Option<File>> {
    kcoder_config::PrivateDirectory::open_existing(parent)?.exclusive_lock_within(
        OsStr::new(".snapshot-repositories.lock"),
        CLEANUP_TRANSIENT_HOLDER_WAIT,
    )
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

    #[test]
    fn concurrent_subprocess_spawns_do_not_make_sequential_cleanup_busy() {
        // A child between fork and exec briefly keeps the released cleanup lease.
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let spawners: Vec<_> = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        let _ = std::process::Command::new("true").status();
                    }
                })
            })
            .collect();
        let temp = tempfile::tempdir().unwrap();
        let outcomes: Vec<bool> = (0..200)
            .map(|_| cleanup(temp.path()).unwrap().is_some())
            .collect();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        spawners
            .into_iter()
            .for_each(|spawner| spawner.join().unwrap());
        assert!(outcomes.into_iter().all(|acquired| acquired));
    }
}

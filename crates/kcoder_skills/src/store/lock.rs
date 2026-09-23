use super::{SkillStoreError, layout::StoreLayout};
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct StoreLock {
    file: File,
}

impl StoreLock {
    pub(crate) fn exclusive(
        layout: &StoreLayout,
        timeout: Duration,
    ) -> Result<Self, SkillStoreError> {
        acquire(&layout.lock, timeout, true, &layout.root)
    }

    pub(crate) fn shared(layout: &StoreLayout, timeout: Duration) -> Result<Self, SkillStoreError> {
        acquire(&layout.lock, timeout, false, &layout.root)
    }

    pub(crate) fn usage(layout: &StoreLayout, timeout: Duration) -> Result<Self, SkillStoreError> {
        acquire(&layout.usage_lock(), timeout, true, &layout.root)
    }

    pub(crate) fn shared_existing(layout: &StoreLayout) -> Result<Option<Self>, SkillStoreError> {
        if !layout.lock.exists() {
            return Ok(None);
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&layout.lock)
            .map_err(|error| SkillStoreError::io("opening existing skill store lock", error))?;
        match FileExt::try_lock_shared(&file) {
            Ok(()) => Ok(Some(Self { file })),
            Err(error) if is_lock_contention(&error) => Err(SkillStoreError::Busy {
                root: layout.root.clone(),
                timeout_ms: 0,
            }),
            Err(error) => Err(SkillStoreError::io(
                "acquiring existing skill store lock",
                error,
            )),
        }
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn acquire(
    path: &Path,
    timeout: Duration,
    exclusive: bool,
    root: &Path,
) -> Result<StoreLock, SkillStoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| SkillStoreError::io("creating skill lock parent", error))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| SkillStoreError::io("opening skill store lock", error))?;
    let started = Instant::now();
    loop {
        let result = if exclusive {
            FileExt::try_lock_exclusive(&file)
        } else {
            FileExt::try_lock_shared(&file)
        };
        match result {
            Ok(()) => return Ok(StoreLock { file }),
            Err(error) if is_lock_contention(&error) => {
                if started.elapsed() >= timeout {
                    return Err(SkillStoreError::Busy {
                        root: root.to_path_buf(),
                        timeout_ms: timeout.as_millis().try_into().unwrap_or(u64::MAX),
                    });
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(SkillStoreError::io("acquiring skill store lock", error)),
        }
    }
}

/// LockFileEx contention surfaces as ERROR_LOCK_VIOLATION (os error 33) on
/// Windows, which Rust classifies as Uncategorized — not WouldBlock. Parallel
/// app-server starts contend on the shared skill store; treating contention as
/// a fatal I/O error killed one of the processes at bootstrap and surfaced as a
/// "conversation list incomplete" banner for its workspace.
fn is_lock_contention(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn live_lock_is_not_stolen_or_deleted() {
        let temp = TempDir::new().unwrap();
        let layout = StoreLayout::new(&temp.path().join("skills")).unwrap();
        let held = StoreLock::exclusive(&layout, DEFAULT_LOCK_TIMEOUT).unwrap();
        let stale_time = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        OpenOptions::new()
            .write(true)
            .open(&layout.lock)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stale_time))
            .unwrap();
        let error = StoreLock::exclusive(&layout, Duration::from_millis(30))
            .err()
            .expect("second exclusive lock must time out");
        assert!(matches!(error, SkillStoreError::Busy { .. }));
        assert!(layout.lock.exists());
        drop(held);
        StoreLock::exclusive(&layout, Duration::from_millis(30)).unwrap();
    }

    #[test]
    fn shared_locks_can_coexist() {
        let temp = TempDir::new().unwrap();
        let layout = StoreLayout::new(&temp.path().join("skills")).unwrap();
        let _first = StoreLock::shared(&layout, DEFAULT_LOCK_TIMEOUT).unwrap();
        let _second = StoreLock::shared(&layout, Duration::from_millis(30)).unwrap();
    }

    #[test]
    fn platform_contention_error_is_retried_not_fatal() {
        // Windows reports LockFileEx contention as ERROR_LOCK_VIOLATION (33),
        // classified Uncategorized rather than WouldBlock; the retry loop must
        // still recognize it or a parallel app-server start dies at bootstrap.
        let contended = std::io::Error::from_raw_os_error(
            fs2::lock_contended_error().raw_os_error().unwrap_or(33),
        );
        assert!(is_lock_contention(&contended));
        assert!(is_lock_contention(&std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "try lock busy"
        )));
        assert!(!is_lock_contention(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "lock file missing"
        )));
    }
}

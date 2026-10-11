use anyhow::{Context, Result};
use kcoder_config::PrivateDirectory;
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub(crate) const INPUT_HISTORY_MAX_ENTRIES: usize = 1000;

pub(crate) fn load_input_history_file(path: &Path) -> Result<Vec<String>> {
    let absolute = std::path::absolute(path).context("failed to resolve input history path")?;
    let directory = PrivateDirectory::open_existing(
        absolute
            .parent()
            .context("input history path has no parent")?,
    )?;
    read_history(
        &directory,
        absolute
            .file_name()
            .context("input history path has no name")?,
    )
    .with_context(|| format!("failed to read input history from {:?}", path))
}

fn read_history(directory: &PrivateDirectory, name: &OsStr) -> Result<Vec<String>> {
    let file = directory.open_regular_file(name)?;
    let mut history = VecDeque::new();
    for line in BufReader::new(file).lines() {
        let line = line.context("failed to read input history entry")?;
        if line.is_empty() {
            continue;
        }
        history.push_back(serde_json::from_str::<String>(&line).unwrap_or(line));
        if history.len() > INPUT_HISTORY_MAX_ENTRIES {
            history.pop_front();
        }
    }
    Ok(history.into())
}

/// Merge new local entries into the current file, never a stale session snapshot.
pub(crate) fn save_input_history_file(path: &Path, history: &[String]) -> Result<()> {
    let (directory, name) = history_directory(path)?;
    let _lock = acquire_history_lock(&directory, &name)?;
    let mut merged = match read_history(&directory, &name) {
        Ok(history) => VecDeque::from(history),
        Err(error) if is_not_found(&error) => VecDeque::new(),
        Err(error) => return Err(error).context("failed to read history before merging"),
    };
    for entry in history {
        if merged.back() != Some(entry) {
            merged.push_back(entry.clone());
            if merged.len() > INPUT_HISTORY_MAX_ENTRIES {
                merged.pop_front();
            }
        }
    }
    write_history(&directory, &name, merged.iter())
        .with_context(|| format!("failed to save input history to {:?}", path))
}

/// Legacy migration initializes only an absent file, including concurrent startup.
pub(crate) fn initialize_input_history_file(
    path: &Path,
    history: &[String],
) -> Result<Vec<String>> {
    let (directory, name) = history_directory(path)?;
    let _lock = acquire_history_lock(&directory, &name)?;
    match read_history(&directory, &name) {
        Ok(current) => return Ok(current),
        Err(error) if is_not_found(&error) => {}
        Err(error) => {
            return Err(error).context("failed to inspect input history migration target");
        }
    }
    let history = &history[history.len().saturating_sub(INPUT_HISTORY_MAX_ENTRIES)..];
    write_history(&directory, &name, history.iter())?;
    Ok(history.to_vec())
}

fn write_history<'a>(
    directory: &PrivateDirectory,
    name: &OsStr,
    history: impl Iterator<Item = &'a String>,
) -> Result<()> {
    let mut content = String::new();
    for entry in history {
        content.push_str(
            &serde_json::to_string(entry).context("failed to serialize input history entry")?,
        );
        content.push('\n');
    }
    directory.atomic_replace(name, content.as_bytes())
}

fn history_directory(path: &Path) -> Result<(PrivateDirectory, OsString)> {
    let absolute = std::path::absolute(path).context("failed to resolve input history path")?;
    let directory = PrivateDirectory::open_or_create(
        absolute
            .parent()
            .context("input history path has no parent")?,
    )?;
    Ok((
        directory,
        absolute
            .file_name()
            .context("input history path has no name")?
            .to_os_string(),
    ))
}

fn acquire_history_lock(directory: &PrivateDirectory, name: &OsStr) -> Result<File> {
    let mut lock_name = name.to_os_string();
    lock_name.push(".lock");
    let started = Instant::now();
    loop {
        if let Some(lock) = directory.try_exclusive_lock(&lock_name)? {
            return Ok(lock);
        }
        anyhow::ensure!(
            started.elapsed() < Duration::from_secs(30),
            "timed out waiting for input history lock"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// Background saves retain unsaved entries without holding a mutex on the UI thread
/// while waiting for disk or another process. Revisions identify entries, not text.
#[derive(Default)]
pub(crate) struct InputHistorySaveState {
    save_lock: Mutex<()>,
    pending: Mutex<VecDeque<(u64, String)>>,
    revision: AtomicU64,
}

impl InputHistorySaveState {
    pub(crate) fn record(&self, entry: Option<String>) -> u64 {
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(entry) = entry {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending.push_back((revision, entry));
            if pending.len() > INPUT_HISTORY_MAX_ENTRIES {
                pending.pop_front();
            }
        }
        revision
    }

    pub(crate) fn save_latest(&self, path: &Path, revision: u64) -> Result<()> {
        let _guard = self
            .save_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.revision.load(Ordering::Acquire) != revision {
            return Ok(());
        }
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let Some((through_revision, _)) = pending.back() else {
            return Ok(());
        };
        let entries: Vec<_> = pending.iter().map(|(_, entry)| entry.clone()).collect();
        save_input_history_file(path, &entries)?;
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|(revision, _)| revision > through_revision);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn wait_for_saved_entry(path: &Path, expected: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if load_input_history_file(path)
                    .is_ok_and(|history| history.last().map(String::as_str) == Some(expected))
                {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("background history save must finish");
    }

    #[tokio::test]
    async fn two_repl_instances_merge_interleaved_input_history_saves() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history").join("input_history.jsonl");
        save_input_history_file(&path, &["shared".into()]).unwrap();
        let mut first = crate::ReplApp::default();
        first.set_input_history_path(path.clone());
        first.load_input_history();
        let mut second = crate::ReplApp::default();
        second.set_input_history_path(path.clone());
        second.load_input_history();

        first.push_input_history("first-instance".into());
        wait_for_saved_entry(&path, "first-instance").await;
        second.push_input_history("second-instance".into());
        wait_for_saved_entry(&path, "second-instance").await;
        assert_eq!(
            load_input_history_file(&path).unwrap(),
            ["shared", "first-instance", "second-instance"]
        );

        first.push_input_history("first-instance-next".into());
        wait_for_saved_entry(&path, "first-instance-next").await;
        assert_eq!(
            load_input_history_file(&path).unwrap(),
            [
                "shared",
                "first-instance",
                "second-instance",
                "first-instance-next"
            ]
        );

        // Repeating an older input is useful history; only adjacent duplicates collapse.
        first.push_input_history("shared".into());
        wait_for_saved_entry(&path, "shared").await;
        first.push_input_history("shared".into());
        assert_eq!(
            load_input_history_file(&path).unwrap(),
            [
                "shared",
                "first-instance",
                "second-instance",
                "first-instance-next",
                "shared"
            ]
        );
    }

    #[test]
    fn stale_tasks_skip_and_failed_saves_retain_pending_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history").join("input_history.jsonl");
        let save = InputHistorySaveState::default();
        let old = save.record(Some("first".into()));
        let current = save.record(Some("second".into()));
        save.save_latest(&path, old).unwrap();
        assert!(!path.exists(), "stale workers must not publish");

        std::fs::create_dir_all(&path).unwrap();
        assert!(save.save_latest(&path, current).is_err());
        std::fs::remove_dir(&path).unwrap();
        let retry = save.record(None);
        save.save_latest(&path, retry).unwrap();
        assert_eq!(load_input_history_file(&path).unwrap(), ["first", "second"]);
        assert!(save.pending.lock().unwrap().is_empty());
        save.save_latest(&path, old).unwrap();
        assert_eq!(load_input_history_file(&path).unwrap(), ["first", "second"]);
    }

    #[test]
    fn file_lock_serializes_writers_and_merges_each_batch() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input_history.jsonl");
        save_input_history_file(&path, &["shared".into()]).unwrap();
        let (directory, name) = history_directory(&path).unwrap();
        let lock = acquire_history_lock(&directory, &name).unwrap();
        let barrier = std::sync::Barrier::new(3);
        let (finished, received) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            for entry in ["first", "second"] {
                let finished = finished.clone();
                let barrier = &barrier;
                let path = &path;
                scope.spawn(move || {
                    barrier.wait();
                    save_input_history_file(path, &[entry.into()]).unwrap();
                    finished.send(()).unwrap();
                });
            }
            barrier.wait();
            assert!(matches!(
                received.recv_timeout(Duration::from_millis(30)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            assert_eq!(load_input_history_file(&path).unwrap(), ["shared"]);
            drop(lock);
        });
        let history = load_input_history_file(&path).unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0], "shared");
        assert!(history.iter().any(|entry| entry == "first"));
        assert!(history.iter().any(|entry| entry == "second"));
    }

    #[tokio::test]
    async fn stale_repl_history_does_not_resurrect_evicted_entries_or_cross_paths() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("first").join("input_history.jsonl");
        let seed: Vec<_> = (0..INPUT_HISTORY_MAX_ENTRIES)
            .map(|index| format!("seed-{index}"))
            .collect();
        initialize_input_history_file(&path, &seed).unwrap();
        let mut first = crate::ReplApp::default();
        first.set_input_history_path(path.clone());
        first.load_input_history();
        let mut second = crate::ReplApp::default();
        second.set_input_history_path(path.clone());
        second.load_input_history();
        first.push_input_history("first-new".into());
        wait_for_saved_entry(&path, "first-new").await;
        second.push_input_history("second-new".into());
        wait_for_saved_entry(&path, "second-new").await;

        let history = load_input_history_file(&path).unwrap();
        assert_eq!(history.len(), INPUT_HISTORY_MAX_ENTRIES);
        assert_eq!(history.first().unwrap(), "seed-2");
        assert_eq!(&history[history.len() - 2..], ["first-new", "second-new"]);

        // An already queued save stays owned by its original account/path after a switch.
        first.push_input_history("original-path-pending".into());
        let other = temp.path().join("second").join("input_history.jsonl");
        first.set_input_history_path(other.clone());
        first.push_input_history("other-path-only".into());
        wait_for_saved_entry(&other, "other-path-only").await;
        wait_for_saved_entry(&path, "original-path-pending").await;
        assert_eq!(
            load_input_history_file(&other).unwrap(),
            ["other-path-only"]
        );
    }

    #[test]
    fn legacy_migration_is_once_and_unreadable_files_are_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input_history.jsonl");
        let legacy = vec!["first".into(), "second".into()];
        assert_eq!(
            initialize_input_history_file(&path, &legacy).unwrap(),
            legacy
        );
        save_input_history_file(&path, &["new".into()]).unwrap();
        assert_eq!(
            initialize_input_history_file(&path, &legacy).unwrap(),
            ["first", "second", "new"]
        );

        let bytes = [0xff, 0xfe];
        std::fs::write(&path, bytes).unwrap();
        assert!(save_input_history_file(&path, &["must not replace".into()]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn input_history_stays_private_and_rejects_linked_history_or_lock() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history").join("input_history.jsonl");
        save_input_history_file(&path, &["private".into()]).unwrap();
        let lock = path.with_file_name("input_history.jsonl.lock");
        for private in [&path, &lock, path.parent().unwrap()] {
            assert_eq!(
                std::fs::metadata(private).unwrap().permissions().mode() & 0o077,
                0
            );
        }
        let external = temp.path().join("external");
        std::fs::write(&external, "do not change").unwrap();
        for linked in [&path, &lock] {
            std::fs::remove_file(linked).unwrap();
            symlink(&external, linked).unwrap();
            assert!(save_input_history_file(&path, &["private-new".into()]).is_err());
            assert_eq!(std::fs::read_to_string(&external).unwrap(), "do not change");
            std::fs::remove_file(linked).unwrap();
            std::fs::write(linked, "private\n").unwrap();
        }
    }

    fn temp_history_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kcoder_repl_input_history_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn save_creates_parent_directory_and_round_trips_entries() {
        let dir = temp_history_path("roundtrip");
        let path = dir.join("nested").join("input_history.txt");
        let history = vec!["first".to_string(), "second".to_string()];

        save_input_history_file(&path, &history).unwrap();

        assert_eq!(load_input_history_file(&path).unwrap(), history);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn multiline_and_unicode_entries_round_trip_as_single_items() {
        let dir = temp_history_path("multiline");
        let path = dir.join("input_history.jsonl");
        let history = vec!["first\nsecond\n".to_string(), "中文🙂\n下一行".to_string()];

        save_input_history_file(&path, &history).unwrap();

        assert_eq!(load_input_history_file(&path).unwrap(), history);
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert_eq!(persisted.lines().count(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_plain_line_history_remains_readable() {
        let path = temp_history_path("legacy");
        std::fs::write(&path, "first\nsecond\n").unwrap();
        assert_eq!(load_input_history_file(&path).unwrap(), ["first", "second"]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn load_filters_empty_lines_and_keeps_recent_entries() {
        let path = temp_history_path("trim");
        let mut content = String::from("\n\n");
        for idx in 0..(INPUT_HISTORY_MAX_ENTRIES + 2) {
            content.push_str(&format!("entry-{idx}\n"));
        }
        std::fs::write(&path, content).unwrap();

        let history = load_input_history_file(&path).unwrap();

        assert_eq!(history.len(), INPUT_HISTORY_MAX_ENTRIES);
        assert_eq!(history.first().unwrap(), "entry-2");
        assert_eq!(
            history.last().unwrap(),
            &format!("entry-{}", INPUT_HISTORY_MAX_ENTRIES + 1)
        );
        let _ = std::fs::remove_file(path);
    }
}

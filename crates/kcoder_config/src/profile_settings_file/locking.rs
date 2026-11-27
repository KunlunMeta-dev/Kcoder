//! Wait only for a bounded lease on the originally opened lock file, never replay an operation.
use super::*;
use std::time::{Duration, Instant};

const WAIT_BUDGET: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

pub(super) fn acquire(directory: &PrivateDirectory, name: &OsStr, exclusive: bool) -> Result<File> {
    acquire_observed(directory, name, exclusive, || {})
}

fn acquire_observed(
    directory: &PrivateDirectory,
    name: &OsStr,
    exclusive: bool,
    opened: impl FnOnce(),
) -> Result<File> {
    let file = match directory.open_read_write_file(name, true) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
            }) =>
        {
            directory.open_read_write_file(name, false)?
        }
        Err(error) => return Err(error),
    };
    let identity = PrivateDirectory::identity_of_file(&file)?;
    opened();
    let deadline = Instant::now() + WAIT_BUDGET;
    loop {
        let result = if exclusive {
            fs2::FileExt::try_lock_exclusive(&file)
        } else {
            fs2::FileExt::try_lock_shared(&file)
        };
        match result {
            Ok(()) => {
                ensure!(
                    PrivateDirectory::identity_of_file(&file)? == identity
                        && directory.regular_file_identity(name)? == identity,
                    "settings_lock_changed"
                );
                return Ok(file);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        Some(code) == fs2::lock_contended_error().raw_os_error()
                    }) => {}
            Err(error) => return Err(error.into()),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        ensure!(!remaining.is_zero(), "settings_busy");
        std::thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn both_read_and_write_leases_wait_for_an_existing_short_transaction() {
        for exclusive in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let name = OsStr::new("settings.json.lock");
            let directory = PrivateDirectory::open_existing(root.path()).unwrap();
            let held = directory.try_exclusive_lock(name).unwrap().unwrap();
            let worker_directory = directory.try_clone().unwrap();
            let (tx, rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                acquire_observed(
                    &worker_directory,
                    OsStr::new("settings.json.lock"),
                    exclusive,
                    || tx.send(()).unwrap(),
                )
            });
            rx.recv_timeout(Duration::from_secs(2)).unwrap();
            // Exceed the former 64 ms coordinator window and the single shared attempt.
            std::thread::sleep(Duration::from_millis(120));
            drop(held);
            drop(worker.join().unwrap().unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_lock_is_never_adopted_after_waiting() {
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        let name = OsStr::new("settings.json.lock");
        let held = directory.try_exclusive_lock(name).unwrap().unwrap();
        let worker_directory = directory.try_clone().unwrap();
        let (tx, rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            acquire_observed(
                &worker_directory,
                OsStr::new("settings.json.lock"),
                true,
                || {
                    tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            )
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        std::fs::rename(root.path().join(name), root.path().join("original.lock")).unwrap();
        let replacement = directory.try_exclusive_lock(name).unwrap().unwrap();
        drop(held);
        release_tx.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().to_string(),
            "settings_lock_changed"
        );
        drop(replacement);
    }
}

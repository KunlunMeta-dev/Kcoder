use anyhow::{Context, Result};
#[cfg(test)]
use std::fs;
use std::path::Path;

const ALPHABET: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ATTEMPTS: usize = 256;

/// Occupy an imported short identity before adopting it; legacy long identities need no slot.
pub fn retain_existing_short_id(registry: &Path, id: &str) -> Result<()> {
    if id.len() != 5 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Ok(());
    }
    let directory = kcoder_config::PrivateDirectory::open_or_create(registry)
        .context("cannot open private short ID registry")?;
    let name = id.to_ascii_lowercase();
    let name = std::ffi::OsStr::new(&name);
    let file = match directory.open_read_write_file(name, true) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
        {
            directory
                .open_read_write_file(name, false)
                .context("invalid existing short ID reservation")?
        }
        Err(error) => return Err(error).context("cannot retain imported short ID"),
    };
    file.sync_all()
        .context("cannot persist imported short ID reservation")?;
    directory.sync().context("cannot persist short ID registry")
}

/// Reserve a five-character ID across processes, rejecting case-only collisions on every OS.
/// Reservations are permanent: deleting an old session must not make its ID refer to a new one.
pub fn reserve_short_id(registry: &Path) -> Result<String> {
    reserve_with(registry, || {
        let mut value = uuid::Uuid::new_v4().as_u128();
        (0..5)
            .map(|_| {
                let character = ALPHABET[(value % 62) as usize] as char;
                value /= 62;
                character
            })
            .collect()
    })
}

fn reserve_with(registry: &Path, mut candidate: impl FnMut() -> String) -> Result<String> {
    let directory = kcoder_config::PrivateDirectory::open_or_create(registry)
        .context("cannot open private short ID registry")?;
    for _ in 0..ATTEMPTS {
        let id = candidate();
        anyhow::ensure!(
            id.len() == 5 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
            "invalid short ID candidate"
        );
        let name = id.to_ascii_lowercase();
        match directory.open_read_write_file(std::ffi::OsStr::new(&name), true) {
            Ok(file) => {
                file.sync_all()
                    .context("cannot persist short ID reservation")?;
                directory
                    .sync()
                    .context("cannot persist short ID registry")?;
                return Ok(id);
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
            {
                continue;
            }
            Err(error) => return Err(error).context("cannot reserve short ID"),
        }
    }
    anyhow::bail!("short ID collision retry limit reached")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_short_id_blocks_case_variants_and_legacy_needs_no_registry() {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("ids");
        retain_existing_short_id(&registry, "legacy-long-session").unwrap();
        assert!(!registry.exists());
        retain_existing_short_id(&registry, "Ab123").unwrap();
        retain_existing_short_id(&registry, "aB123").unwrap();
        assert!(reserve_with(&registry, || "AB123".into()).is_err());
        assert_eq!(fs::read_dir(registry).unwrap().count(), 1);
    }

    const PROCESS_TEST_ROOT: &str = "KCODER_SHORT_ID_PROCESS_TEST_ROOT";
    const PROCESS_TEST_WORKER: &str = "KCODER_SHORT_ID_PROCESS_TEST_WORKER";

    struct ReservationChildren(Vec<std::process::Child>);

    impl Drop for ReservationChildren {
        fn drop(&mut self) {
            // Reap every owned child even when an assertion or timeout aborts the test.
            for child in &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[test]
    fn short_id_reservation_process_child() {
        let Some(root) = std::env::var_os(PROCESS_TEST_ROOT) else {
            return;
        };
        let worker = std::env::var(PROCESS_TEST_WORKER).unwrap();
        assert!(matches!(worker.as_str(), "0" | "1"));
        let root = std::path::PathBuf::from(root);
        assert!(root.is_absolute());
        assert_eq!(
            fs::read(root.join("test-marker")).unwrap(),
            b"short-id-process-test"
        );
        fs::write(root.join(format!("ready-{worker}")), b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !root.join("go").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "parent did not release barrier"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let mut attempts = 0;
        let id = reserve_with(&root.join("registry"), || {
            attempts += 1;
            match attempts {
                1 => "hI789".to_string(),
                2 if worker == "0" => "Ab123".to_string(),
                2 => "aB123".to_string(),
                _ if worker == "0" => "Cd456".to_string(),
                _ => "Ef456".to_string(),
            }
        })
        .unwrap();
        fs::write(
            root.join(format!("result-{worker}")),
            format!("{id}:{attempts}"),
        )
        .unwrap();
    }

    #[test]
    fn short_ids_cross_process_case_collision_retries_without_overwriting_history() {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("registry");
        reserve_with(&registry, || "Hi789".into()).unwrap();
        fs::write(registry.join("hi789"), b"historical reservation sentinel").unwrap();
        fs::write(root.path().join("test-marker"), b"short-id-process-test").unwrap();
        let executable = std::env::current_exe().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut children = ReservationChildren(Vec::new());
        for worker in ["0", "1"] {
            children.0.push(
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "short_id::tests::short_id_reservation_process_child",
                        "--nocapture",
                    ])
                    .env(PROCESS_TEST_ROOT, root.path())
                    .env(PROCESS_TEST_WORKER, worker)
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        while !(root.path().join("ready-0").exists() && root.path().join("ready-1").exists()) {
            assert!(
                std::time::Instant::now() < deadline,
                "children did not reach barrier"
            );
            for child in &mut children.0 {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "child exited before barrier"
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        fs::write(root.path().join("go"), b"go").unwrap();
        loop {
            let mut finished = 0;
            for child in &mut children.0 {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "reservation child failed: {status}");
                    finished += 1;
                }
            }
            if finished == children.0.len() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "reservation children timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let results: Vec<_> = ["0", "1"]
            .into_iter()
            .map(|worker| {
                let result =
                    fs::read_to_string(root.path().join(format!("result-{worker}"))).unwrap();
                let (id, attempts) = result.split_once(':').unwrap();
                (id.to_ascii_lowercase(), attempts.parse::<usize>().unwrap())
            })
            .collect();
        assert_eq!(results.iter().filter(|(id, _)| id == "ab123").count(), 1);
        assert_ne!(results[0].0, results[1].0);
        for (id, attempts) in results {
            assert_eq!(attempts, if id == "ab123" { 2 } else { 3 });
            assert!(registry.join(id).is_file());
        }
        assert_eq!(
            fs::read(registry.join("hi789")).unwrap(),
            b"historical reservation sentinel"
        );
        assert_eq!(fs::read_dir(&registry).unwrap().count(), 3);
    }

    #[test]
    fn short_ids_retry_case_collisions_and_never_overwrite() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            reserve_with(root.path(), || "Ab123".into()).unwrap(),
            "Ab123"
        );
        let mut candidates = ["aB123", "CD456"].into_iter();
        assert_eq!(
            reserve_with(root.path(), || candidates.next().unwrap().into()).unwrap(),
            "CD456"
        );
        assert!(reserve_with(root.path(), || "AB123".into()).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        assert!(reserve_with(root.path(), || "../xx".into()).is_err());
    }

    #[test]
    fn short_ids_are_five_base62_characters_and_concurrent_reservations_are_unique() {
        let root = tempfile::tempdir().unwrap();
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let path = root.path().to_path_buf();
                std::thread::spawn(move || {
                    (0..16)
                        .map(|_| reserve_short_id(&path).unwrap())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut ids = std::collections::HashSet::new();
        for id in workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap())
        {
            assert_eq!(id.len(), 5);
            assert!(id.bytes().all(|byte| byte.is_ascii_alphanumeric()));
            assert!(ids.insert(id.to_ascii_lowercase()));
        }
        assert_eq!(ids.len(), 64);
    }
}

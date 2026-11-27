//! Resource exhaustion is confined to a single owned child, never the shared test runner.
use super::*;
use crate::external_history::ExternalHistoryStore;
use std::{ffi::OsStr, fs::File, io::Cursor};

#[test]
fn actual_descriptor_exhaustion_keeps_the_original_archive_reservation_recoverable() {
    const CHILD: &str = "KCODER_OWNED_ARCHIVE_FD_PRESSURE_CHILD";
    if let Some(root) = std::env::var_os(CHILD) {
        let root = std::path::Path::new(&root);
        assert_eq!(
            std::fs::read(root.join("owner")).unwrap(),
            b"owned-fd-pressure-v1"
        );
        let bytes = b"{\"synthetic\":true}\n";
        let snapshot = super::archive::tests::snapshot(bytes);
        let store = ExternalHistoryStore::open(root).unwrap();
        let budget = store
            .prepare_resource_budget(
                "batch-fds",
                vec!["history-fds".into()],
                MigrationResourceLimits::default(),
            )
            .unwrap();
        let mut import = store.begin_managed("history-fds", &snapshot).unwrap();
        let archive = import.archive_id().to_owned();
        let mut previous = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: a valid writable rlimit is provided, in the isolated exact-test child only.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut previous) },
            0
        );
        let low = libc::rlimit {
            rlim_cur: previous.rlim_cur.min(64),
            rlim_max: previous.rlim_max,
        };
        assert!(
            low.rlim_cur >= 24,
            "owned child requires at least 24 descriptor slots"
        );
        // SAFETY: only this child lowers its soft limit; the original hard limit is preserved.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &low) }, 0);
        let mut held = Vec::new();
        loop {
            match File::open("/dev/null") {
                Ok(file) => held.push(file),
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
                    break;
                }
            }
            assert!(held.len() <= 64);
        }
        assert!(
            import
                .stage_source(&mut Cursor::new(bytes), &mut |_| true)
                .is_err()
        );
        drop(held);
        drop(import);
        assert!(
            !root
                .join("external-history")
                .join(&archive)
                .join("source.bin")
                .exists()
        );
        let reopened = ExternalHistoryStore::open_existing(root).unwrap().unwrap();
        assert_eq!(
            reopened.recorded_resource_budget("batch-fds").unwrap(),
            Some(budget.clone())
        );
        let usage = reopened.resource_budget_usage(&budget).unwrap();
        assert_eq!(usage.reserved_files, 4);
        assert_eq!(usage.committed_files, 0);
        let mut recovered = reopened.begin_managed("history-fds", &snapshot).unwrap();
        recovered
            .stage_source(&mut Cursor::new(bytes), &mut |_| true)
            .unwrap();
        recovered.finish(&mut |_| true).unwrap();
        let final_usage = reopened.resource_budget_usage(&budget).unwrap();
        assert_eq!(
            (final_usage.reserved_files, final_usage.committed_files),
            (0, 4)
        );
        let directory = PrivateDirectory::open_existing(root).unwrap();
        let mut proof = directory
            .open_read_write_file(OsStr::new("fd-pressure-proof"), true)
            .unwrap();
        std::io::Write::write_all(&mut proof, b"actual-emfile-original-allocation-recovered")
            .unwrap();
        proof.sync_all().unwrap();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("owner"), b"owned-fd-pressure-v1").unwrap();
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }
    let qualified = concat!(
        module_path!(),
        "::actual_descriptor_exhaustion_keeps_the_original_archive_reservation_recoverable"
    );
    let name = qualified.split_once("::").unwrap().1;
    let mut child = Child(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env(CHILD, root.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned fd-pressure child timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read(root.path().join("fd-pressure-proof")).unwrap(),
        b"actual-emfile-original-allocation-recovered"
    );
}

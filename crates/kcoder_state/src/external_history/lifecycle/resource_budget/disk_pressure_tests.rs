//! An owned user/mount namespace bounds real ENOSPC to an eight-MiB tmpfs.
use super::*;
use crate::external_history::ExternalHistoryStore;
use std::{
    ffi::CString,
    io::{Cursor, Write},
};

#[test]
fn actual_enospc_after_admission_preserves_the_original_reservation_and_recovery() {
    const CHILD: &str = "KCODER_OWNED_ARCHIVE_DISK_PRESSURE_CHILD";
    if let Some(root) = std::env::var_os(CHILD) {
        let root = std::path::Path::new(&root);
        assert_eq!(
            std::fs::read(root.join("owner")).unwrap(),
            b"owned-disk-pressure-v1"
        );
        let mount = root.join("profile");
        let mount_path =
            CString::new(std::os::unix::ffi::OsStrExt::as_bytes(mount.as_os_str())).unwrap();
        let filesystem = CString::new("tmpfs").unwrap();
        let options = CString::new("size=8m,mode=700").unwrap();
        // SAFETY: this exact child was started in its own user/mount namespace. The only
        // mount target is its parent's fresh, owned fixture; all C strings remain live.
        assert_eq!(
            unsafe {
                libc::mount(
                    filesystem.as_ptr(),
                    mount_path.as_ptr(),
                    filesystem.as_ptr(),
                    libc::MS_NODEV | libc::MS_NOSUID,
                    options.as_ptr().cast(),
                )
            },
            0,
            "owned tmpfs mount failed: {}",
            std::io::Error::last_os_error()
        );
        let store = ExternalHistoryStore::open(&mount).unwrap();
        let budget = store
            .prepare_resource_budget(
                "batch-disk",
                vec!["history-disk".into()],
                MigrationResourceLimits {
                    min_free_bytes: 1024 * 1024,
                    ..Default::default()
                },
            )
            .unwrap();
        let bytes = b"{\"synthetic\":true}\n";
        let snapshot = super::archive::tests::snapshot(bytes);
        let mut import = store.begin_managed("history-disk", &snapshot).unwrap();
        let archive = import.archive_id().to_owned();
        let filler_path = mount.join("owned-filler");
        let mut filler = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&filler_path)
            .unwrap();
        let block = [0u8; 64 * 1024];
        let mut total = 0;
        loop {
            match filler.write(&block) {
                Ok(count) => {
                    assert!(count > 0);
                    total += count;
                }
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
                    break;
                }
            }
            assert!(
                total <= 8 * 1024 * 1024,
                "fixture must never exceed the owned tmpfs bound"
            );
        }
        // Capacity changed after admission: this must exercise a real failed payload write.
        assert!(
            import
                .stage_source(&mut Cursor::new(bytes), &mut |_| true)
                .is_err()
        );
        assert!(
            !mount
                .join("external-history")
                .join(&archive)
                .join("source.bin")
                .exists()
        );
        let usage = store.resource_budget_usage(&budget).unwrap();
        assert_eq!((usage.reserved_files, usage.committed_files), (4, 0));
        drop(import);
        drop(filler);
        std::fs::remove_file(filler_path).unwrap();
        let reopened = ExternalHistoryStore::open_existing(&mount)
            .unwrap()
            .unwrap();
        assert_eq!(
            reopened.recorded_resource_budget("batch-disk").unwrap(),
            Some(budget.clone())
        );
        let mut recovered = reopened.begin_managed("history-disk", &snapshot).unwrap();
        recovered
            .stage_source(&mut Cursor::new(bytes), &mut |_| true)
            .unwrap();
        recovered.finish(&mut |_| true).unwrap();
        let final_usage = reopened.resource_budget_usage(&budget).unwrap();
        assert_eq!(
            (final_usage.reserved_files, final_usage.committed_files),
            (0, 4)
        );
        std::fs::write(
            root.join("disk-pressure-proof"),
            b"actual-eight-mib-enospc-original-allocation-recovered",
        )
        .unwrap();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("owner"), b"owned-disk-pressure-v1").unwrap();
    std::fs::create_dir(root.path().join("profile")).unwrap();
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                // SAFETY: the child has its own process group whose id is the exact owned PID.
                unsafe {
                    libc::kill(-(self.0.id() as i32), libc::SIGKILL);
                }
                let _ = self.0.wait();
            }
        }
    }
    let qualified = concat!(
        module_path!(),
        "::actual_enospc_after_admission_preserves_the_original_reservation_and_recovery"
    );
    let name = qualified.split_once("::").unwrap().1;
    use std::os::unix::process::CommandExt;
    let mut child = Child(
        std::process::Command::new("unshare")
            .args([
                "--user",
                "--map-root-user",
                "--mount",
                "--fork",
                "--kill-child=KILL",
                "--propagation",
                "private",
                "--",
            ])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env(CHILD, root.path())
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("owned ENOSPC test requires util-linux unshare"),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned disk-pressure child timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read(root.path().join("disk-pressure-proof")).unwrap(),
        b"actual-eight-mib-enospc-original-allocation-recovered"
    );
    assert_eq!(
        std::fs::read_dir(root.path().join("profile"))
            .unwrap()
            .count(),
        0,
        "the child mount must disappear with its isolated namespace"
    );
}

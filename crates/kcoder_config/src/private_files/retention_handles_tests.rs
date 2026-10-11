use super::*;
use std::io::Read;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

thread_local! {
    static BEFORE_QUARANTINE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn before_quarantine() {
    BEFORE_QUARANTINE.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}

fn fixture() -> (tempfile::TempDir, PrivateDirectory) {
    let temp = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_or_create(temp.path()).unwrap();
    (temp, directory)
}

#[test]
fn retention_identity_rejects_permissions_links_replacement_and_version() {
    let (temp, directory) = fixture();
    directory
        .atomic_replace(OsStr::new("entry"), b"original")
        .unwrap();
    let original = directory
        .retention_regular_identity(OsStr::new("entry"))
        .unwrap();
    directory
        .open_verified_regular(OsStr::new("entry"), &original)
        .unwrap();
    let mut future = original.clone();
    future.version = 2;
    assert!(
        directory
            .open_verified_regular(OsStr::new("entry"), &future)
            .is_err()
    );
    std::fs::hard_link(temp.path().join("entry"), temp.path().join("alias")).unwrap();
    assert!(
        directory
            .open_verified_regular(OsStr::new("entry"), &original)
            .is_err()
    );
    std::fs::remove_file(temp.path().join("alias")).unwrap();
    std::fs::set_permissions(
        temp.path().join("entry"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(
        directory
            .open_verified_regular(OsStr::new("entry"), &original)
            .is_err()
    );
    assert_eq!(
        std::fs::metadata(temp.path().join("entry"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    std::fs::set_permissions(
        temp.path().join("entry"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    directory
        .atomic_replace(OsStr::new("entry"), b"replacement")
        .unwrap();
    assert!(
        directory
            .open_verified_regular(OsStr::new("entry"), &original)
            .is_err()
    );
    symlink("entry", temp.path().join("link")).unwrap();
    assert!(
        directory
            .open_verified_regular(OsStr::new("link"), &original)
            .is_err()
    );
    assert_eq!(
        std::fs::read(temp.path().join("entry")).unwrap(),
        b"replacement"
    );
}

#[test]
fn retention_existing_lease_never_creates_missing_object_and_is_nonblocking() {
    let (temp, directory) = fixture();
    let created = directory
        .try_exclusive_lock(OsStr::new("lease"))
        .unwrap()
        .unwrap();
    let identity = directory
        .retention_regular_identity(OsStr::new("lease"))
        .unwrap();
    let start = Instant::now();
    assert!(
        directory
            .try_existing_verified_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none()
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(
        directory
            .try_existing_verified_lock(
                OsStr::new("missing"),
                &identity,
                PrivateLeaseMode::Exclusive
            )
            .is_err()
    );
    assert!(!temp.path().join("missing").exists());
    drop(created);
    let claimed = directory
        .try_existing_verified_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.identity(), &identity);
}

#[test]
fn retention_quarantine_is_noreplace_and_preserves_raced_replacement() {
    let (temp, directory) = fixture();
    directory
        .atomic_replace(OsStr::new("entry"), b"original")
        .unwrap();
    directory
        .atomic_replace(OsStr::new("occupied"), b"other")
        .unwrap();
    let identity = directory
        .retention_regular_identity(OsStr::new("entry"))
        .unwrap();
    assert!(
        directory
            .quarantine_verified_entry(OsStr::new("entry"), &identity, OsStr::new("occupied"))
            .is_err()
    );
    assert_eq!(
        std::fs::read(temp.path().join("occupied")).unwrap(),
        b"other"
    );
    let path = temp.path().to_path_buf();
    BEFORE_QUARANTINE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(path.join("entry"), path.join("original-held")).unwrap();
            std::fs::write(path.join("entry"), b"new object").unwrap();
            std::fs::set_permissions(path.join("entry"), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }))
    });
    assert!(
        directory
            .quarantine_verified_entry(
                OsStr::new("entry"),
                &identity,
                OsStr::new("exclusive-quarantine")
            )
            .is_err()
    );
    assert_eq!(
        std::fs::read(temp.path().join("original-held")).unwrap(),
        b"original"
    );
    assert_eq!(
        std::fs::read(temp.path().join("exclusive-quarantine")).unwrap(),
        b"new object"
    );
}

#[test]
fn retention_manifest_rejects_unknown_children_before_mutation() {
    let (temp, directory) = fixture();
    directory
        .atomic_replace(OsStr::new("entry"), b"original")
        .unwrap();
    let entry = PrivateRemovalEntry {
        name: "entry".into(),
        identity: directory
            .retention_regular_identity(OsStr::new("entry"))
            .unwrap(),
    };
    directory
        .atomic_replace(OsStr::new("unexpected"), b"preserve")
        .unwrap();
    assert!(directory.remove_verified_manifest(&[entry]).is_err());
    assert_eq!(
        std::fs::read(temp.path().join("entry")).unwrap(),
        b"original"
    );
    assert_eq!(
        std::fs::read(temp.path().join("unexpected")).unwrap(),
        b"preserve"
    );
}

#[test]
fn retention_manifest_deletes_expected_leaves_then_exact_empty_directory() {
    let (temp, directory) = fixture();
    let child = directory
        .open_child(OsStr::new("quarantined-owner"), true)
        .unwrap();
    let child_identity = child.retention_identity().unwrap();
    assert!(
        directory
            .remove_verified_empty_directory(OsStr::new("quarantined-owner"), &child_identity)
            .is_ok()
    );
    let child = directory.open_child(OsStr::new("new-owner"), true).unwrap();
    let new_identity = child.retention_identity().unwrap();
    child
        .atomic_replace(OsStr::new("payload"), b"body")
        .unwrap();
    let identity = child
        .retention_regular_identity(OsStr::new("payload"))
        .unwrap();
    assert!(
        directory
            .remove_verified_empty_directory(OsStr::new("new-owner"), &new_identity)
            .is_err()
    );
    child
        .quarantine_verified_entry(
            OsStr::new("payload"),
            &identity,
            OsStr::new("delete-payload"),
        )
        .unwrap();
    // A future service writes its verified quarantine journal here, before
    // invoking unlink. The fixture records it outside the quarantined tree.
    directory
        .atomic_replace(OsStr::new("quarantined-proof"), b"delete-payload:verified")
        .unwrap();
    let entry = PrivateRemovalEntry {
        name: "delete-payload".into(),
        identity,
    };
    let result = child.remove_verified_manifest(&[entry]).unwrap();
    assert_eq!(result.removed, vec![OsString::from("delete-payload")]);
    assert!(result.failure.is_none());
    directory
        .remove_verified_empty_directory(OsStr::new("new-owner"), &new_identity)
        .unwrap();
    assert!(!temp.path().join("new-owner").exists());
}

#[test]
fn retention_manifest_reports_unlink_when_directory_sync_fails() {
    use super::super::{UNIX_TEST_FAILURE_POINT, UnixFailurePoint};
    let (temp, directory) = fixture();
    directory
        .atomic_replace(OsStr::new("quarantined"), b"body")
        .unwrap();
    let entry = PrivateRemovalEntry {
        name: "quarantined".into(),
        identity: directory
            .retention_regular_identity(OsStr::new("quarantined"))
            .unwrap(),
    };
    UNIX_TEST_FAILURE_POINT.with(|failure| failure.set(UnixFailurePoint::DirectorySynced as u8));
    let result = directory.remove_verified_manifest(&[entry]).unwrap();
    assert_eq!(result.removed, vec![OsString::from("quarantined")]);
    assert!(
        result.failure.is_some(),
        "sync error cannot be reported as confirmed completion"
    );
    assert!(!temp.path().join("quarantined").exists());
    directory.sync().unwrap();
}

#[test]
fn retention_identity_rejects_fifo_and_foreign_uid_without_changes() {
    let (temp, directory) = fixture();
    directory
        .atomic_replace(OsStr::new("entry"), b"body")
        .unwrap();
    let identity = directory
        .retention_regular_identity(OsStr::new("entry"))
        .unwrap();
    let fifo =
        std::ffi::CString::new(temp.path().join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: a private fixture path is valid/NUL-terminated; mkfifo does not
    // dereference Rust memory besides that string.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let start = Instant::now();
    assert!(
        directory
            .open_verified_regular(OsStr::new("fifo"), &identity)
            .is_err()
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    // Non-root hosts cannot create a foreign-uid fixture; their UID validation
    // remains covered by source and requires a privileged platform test.
    if unsafe { libc::geteuid() } == 0 {
        let path = std::ffi::CString::new(temp.path().join("entry").as_os_str().as_encoded_bytes())
            .unwrap();
        // SAFETY: only the dedicated fixture leaf is changed.
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 65534, 65534) }, 0);
        assert!(
            directory
                .open_verified_regular(OsStr::new("entry"), &identity)
                .is_err()
        );
        assert_eq!(std::fs::read(temp.path().join("entry")).unwrap(), b"body");
    }
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn retention_lock_child() {
    let Some(path) = std::env::var_os("KCODER_RETENTION_TEST_LEASE_ROOT") else {
        return;
    };
    let directory = PrivateDirectory::open_existing(std::path::Path::new(&path)).unwrap();
    let expected = directory
        .retention_regular_identity(OsStr::new("lease"))
        .unwrap();
    let _lease = directory
        .try_existing_verified_lock(OsStr::new("lease"), &expected, PrivateLeaseMode::Exclusive)
        .unwrap()
        .unwrap();
    std::fs::write(std::path::Path::new(&path).join("child-ready"), b"ready").unwrap();
    let mut byte = [0];
    let _ = std::io::stdin().read_exact(&mut byte);
}

#[test]
fn retention_real_process_kill_releases_existing_lease() {
    let (temp, directory) = fixture();
    directory
        .open_read_write_file(OsStr::new("lease"), true)
        .unwrap();
    let identity = directory
        .retention_regular_identity(OsStr::new("lease"))
        .unwrap();
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "private_files::retention_handles::tests::retention_lock_child",
                "--nocapture",
            ])
            .env("KCODER_RETENTION_TEST_LEASE_ROOT", temp.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !temp.path().join("child-ready").exists() {
        assert!(Instant::now() < deadline, "lock child did not become ready");
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "lock child exited prematurely"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        directory
            .try_existing_verified_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_none()
    );
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(
        directory
            .try_existing_verified_lock(OsStr::new("lease"), &identity, PrivateLeaseMode::Exclusive)
            .unwrap()
            .is_some()
    );
}

#[test]
fn retention_low_nofile_child() {
    let Some(path) = std::env::var_os("KCODER_RETENTION_TEST_LOW_FD_ROOT") else {
        return;
    };
    let directory = PrivateDirectory::open_existing(std::path::Path::new(&path)).unwrap();
    let mut limits = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: correctly sized, valid rlimit output pointer.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) },
        0
    );
    limits.rlim_cur = limits.rlim_cur.min(24);
    // SAFETY: only this isolated child process's soft limit is reduced.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limits) }, 0);
    let manifest = (0..32)
        .map(|index| {
            let name = OsString::from(format!("quarantined-{index}"));
            PrivateRemovalEntry {
                identity: directory.retention_regular_identity(&name).unwrap(),
                name,
            }
        })
        .collect::<Vec<_>>();
    let result = directory.remove_verified_manifest(&manifest).unwrap();
    assert_eq!(result.removed.len(), 32);
    assert!(result.failure.is_none());
}

#[test]
fn retention_manifest_does_not_hold_one_fd_per_leaf() {
    let (temp, directory) = fixture();
    for index in 0..32 {
        directory
            .atomic_replace(OsStr::new(&format!("quarantined-{index}")), b"body")
            .unwrap();
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "private_files::retention_handles::tests::retention_low_nofile_child",
            "--nocapture",
        ])
        .env("KCODER_RETENTION_TEST_LOW_FD_ROOT", temp.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "low-FD child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

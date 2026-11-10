#![cfg(target_os = "linux")]

use kcoder_process_supervisor::linux_stdio::{
    CLEANUP_CONFIRMED_BYTES, INTERNAL_COMMAND_OWNER_RECEIPT_V1, INTERNAL_COMMAND_OWNER_V1,
    INTERNAL_STDIO_OWNER_V1, StdioOwnerGuard,
};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Reference(OwnedFd);
impl Reference {
    fn acquire(pid: u32, parent: u32) -> Self {
        let identity = |pid| {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
            let parts: Vec<_> = stat
                .rsplit_once(") ")
                .unwrap()
                .1
                .split_whitespace()
                .collect();
            (
                parts[1].parse::<u32>().unwrap(),
                parts[19].parse::<u64>().unwrap(),
            )
        };
        let before = identity(pid);
        assert_eq!(before.0, parent, "fixture ownership changed");
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        assert!(raw >= 0, "pidfd is required for owned-process tests");
        // SAFETY: pidfd_open returned a new owned descriptor.
        let handle = Self(unsafe { OwnedFd::from_raw_fd(raw as i32) });
        assert_eq!(identity(pid), before);
        handle
    }
    fn exited(&self) -> bool {
        let mut fd = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        (unsafe { libc::poll(&mut fd, 1, 0) }) == 1
    }
    fn kill(&self) {
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.0.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
        }
    }
}

struct Fixture {
    child: Child,
    references: Vec<Reference>,
    directory: Option<tempfile::TempDir>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for reference in self.references.iter().rev() {
            if !reference.exited() {
                reference.kill();
            }
        }
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(3);
        while (matches!(self.child.try_wait(), Ok(None))
            || self.references.iter().any(|reference| !reference.exited()))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.references.iter().any(|reference| !reference.exited()) {
            let retained = self.directory.take().unwrap().keep();
            eprintln!(
                "Owned fixture still active; state retained at {}",
                retained.display()
            );
        }
    }
}

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "owned process deadline exceeded");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn marker(root: &Path, name: &str) -> u32 {
    let mut value = None;
    wait_until(|| {
        value = std::fs::read_to_string(root.join(name))
            .ok()
            .and_then(|value| value.parse().ok());
        value.is_some()
    });
    value.unwrap()
}
fn fixture_path() -> PathBuf {
    std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("current workspace root"),
    )
    .join("crates/kcoder_process_supervisor")
    .join("tests/fixtures/linux_stdio_tree.py")
}
fn owner() -> &'static str {
    env!("CARGO_BIN_EXE_kcoder-process-supervisor")
}

#[test]
fn receipt_descriptor_is_not_inherited_by_target_and_confirms_only_real_cleanup() {
    use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cleanup.receipt");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    let fd = file.as_raw_fd();
    let python = which::which("python3").unwrap();
    let script = "import os,sys\ntry: os.fstat(int(sys.argv[1]))\nexcept OSError: sys.exit(0)\nraise SystemExit(31)";
    let mut command = Command::new(owner());
    command
        .arg(INTERNAL_COMMAND_OWNER_RECEIPT_V1)
        .arg(std::process::id().to_string())
        .arg(fd.to_string())
        .arg(python)
        .arg("-c")
        .arg(script)
        .arg(fd.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(std::fs::read(&path).unwrap(), CLEANUP_CONFIRMED_BYTES);
}

#[test]
fn live_owner_emits_no_receipt_until_requested_cleanup_has_finished() {
    use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cleanup.receipt");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    let fd = file.as_raw_fd();
    let mut command = Command::new(owner());
    command
        .arg(INTERNAL_COMMAND_OWNER_RECEIPT_V1)
        .arg(std::process::id().to_string())
        .arg(fd.to_string())
        .arg("/bin/sh")
        .arg("-c")
        .arg("printf ready > \"$1\"; exec /bin/sleep 60")
        .arg("owned-receipt-fixture")
        .arg(directory.path().join("started"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    let guard = StdioOwnerGuard::for_child(child.id()).unwrap();
    wait_until(|| directory.path().join("started").exists());
    assert!(std::fs::read(&path).unwrap().is_empty());
    guard.request_stop();
    wait_until(|| child.try_wait().unwrap().is_some());
    assert_eq!(std::fs::read(&path).unwrap(), CLEANUP_CONFIRMED_BYTES);
}

#[test]
fn command_owner_preserves_exit_codes_and_terminating_signals() {
    use std::os::unix::process::ExitStatusExt;
    for (script, code, signal) in [
        ("exit 37", Some(37), None),
        ("kill -TERM $$", None, Some(libc::SIGTERM)),
    ] {
        let child = Command::new(owner())
            .args([
                INTERNAL_COMMAND_OWNER_V1,
                &std::process::id().to_string(),
                "/bin/sh",
                "-c",
                script,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let reference = Reference::acquire(child.id(), std::process::id());
        let mut fixture = Fixture {
            child,
            references: vec![reference],
            directory: Some(tempfile::tempdir().unwrap()),
        };
        let mut status = None;
        wait_until(|| {
            status = fixture.child.try_wait().unwrap();
            status.is_some()
        });
        let status = status.unwrap();
        assert_eq!(status.code(), code);
        assert_eq!(status.signal(), signal);
    }
}

#[test]
fn stopped_command_is_visible_to_host_and_cancel_does_not_resume_target_code() {
    use std::os::unix::process::ExitStatusExt;
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-resume");
    let child = Command::new(owner())
        .args([
            INTERNAL_COMMAND_OWNER_V1,
            &std::process::id().to_string(),
            "/bin/sh",
            "-c",
            "kill -STOP $$; printf resumed > \"$1\"; exec sleep 60",
            "owned-stop-probe",
        ])
        .arg(&marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let reference = Reference::acquire(child.id(), std::process::id());
    let stop = StdioOwnerGuard::for_child(child.id()).unwrap();
    let mut fixture = Fixture {
        child,
        references: vec![reference],
        directory: Some(directory),
    };
    wait_until(|| {
        std::fs::read_to_string(format!("/proc/{}/stat", fixture.child.id())).is_ok_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, state)| state.starts_with("T "))
        })
    });
    let children = std::fs::read_to_string(format!(
        "/proc/{}/task/{}/children",
        fixture.child.id(),
        fixture.child.id()
    ))
    .unwrap();
    let target: u32 = children.split_whitespace().next().unwrap().parse().unwrap();
    fixture
        .references
        .push(Reference::acquire(target, fixture.child.id()));
    stop.request_stop();
    let mut status = None;
    wait_until(|| {
        status = fixture.child.try_wait().unwrap();
        status.is_some()
    });
    assert_eq!(status.unwrap().signal(), Some(libc::SIGTERM));
    assert!(
        !marker.exists(),
        "cancellation resumed target code before terminating it"
    );
}

#[test]
fn stdio_owner_preserves_protocol_and_reaps_detached_children_after_target_exit() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_owned();
    let python = which::which("python3").unwrap();
    let mut child = Command::new(owner())
        .args([INTERNAL_STDIO_OWNER_V1, &std::process::id().to_string()])
        .arg(python)
        .arg(fixture_path())
        .arg("tree")
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let reference = Reference::acquire(child.id(), std::process::id());
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut fixture = Fixture {
        child,
        references: vec![reference],
        directory: Some(directory),
    };
    let target = marker(&root, "target.pid");
    fixture
        .references
        .push(Reference::acquire(target, fixture.child.id()));
    let leaf = marker(&root, "leaf.pid");
    fixture.references.push(Reference::acquire(leaf, target));
    stdin.write_all("协议逐字节🙂\n".as_bytes()).unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    assert_eq!(line, "协议逐字节🙂\n");
    drop(stdin);
    wait_until(|| fixture.child.try_wait().unwrap().is_some());
    assert!(
        fixture.references.iter().all(Reference::exited),
        "detached child survived a normal root exit"
    );
}

#[test]
fn parent_sigkill_stops_even_stdin_ignoring_roots_and_detached_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_owned();
    let python = which::which("python3").unwrap();
    let child = Command::new(python)
        .arg(fixture_path())
        .arg("parent")
        .arg(&root)
        .arg(owner())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let reference = Reference::acquire(child.id(), std::process::id());
    let mut fixture = Fixture {
        child,
        references: vec![reference],
        directory: Some(directory),
    };
    let supervisor = marker(&root, "owner.pid");
    fixture
        .references
        .push(Reference::acquire(supervisor, fixture.child.id()));
    let target = marker(&root, "target.pid");
    fixture
        .references
        .push(Reference::acquire(target, supervisor));
    let leaf = marker(&root, "leaf.pid");
    fixture.references.push(Reference::acquire(leaf, target));
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    wait_until(|| fixture.references.iter().all(Reference::exited));
}

#[test]
fn explicit_owner_stop_uses_a_stable_reference_and_finishes_the_whole_tree() {
    use std::os::unix::process::CommandExt;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_owned();
    let python = which::which("python3").unwrap();
    let mut command = Command::new(owner());
    // SAFETY: this pre-exec closure calls only async-signal-safe libc functions.
    unsafe {
        command.pre_exec(|| {
            let mut blocked: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut blocked);
            libc::sigaddset(&mut blocked, libc::SIGTERM);
            if libc::sigprocmask(libc::SIG_BLOCK, &blocked, std::ptr::null_mut()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .args([INTERNAL_STDIO_OWNER_V1, &std::process::id().to_string()])
        .arg(python)
        .arg(fixture_path())
        .arg("stubborn")
        .arg(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let reference = Reference::acquire(child.id(), std::process::id());
    let stop = StdioOwnerGuard::for_child(child.id()).unwrap();
    let mut fixture = Fixture {
        child,
        references: vec![reference],
        directory: Some(directory),
    };
    let target = marker(&root, "target.pid");
    fixture
        .references
        .push(Reference::acquire(target, fixture.child.id()));
    let leaf = marker(&root, "leaf.pid");
    fixture.references.push(Reference::acquire(leaf, target));
    stop.request_stop();
    wait_until(|| fixture.child.try_wait().unwrap().is_some());
    assert!(fixture.references.iter().all(Reference::exited));
}

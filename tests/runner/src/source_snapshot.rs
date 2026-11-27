//! Read-only source observations for evidence-producing suites.
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SourceSnapshot {
    pub git_commit: String,
    pub clean: bool,
}

fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

enum Probe {
    Complete(ExitStatus, Vec<u8>),
    Exceeded,
}

/// Read at most one byte beyond the budget and terminate only this owned tree
/// on overflow or timeout. Git output never enters persistent evidence.
fn probe(command: &mut Command, limit: usize, timeout: Duration) -> Option<Probe> {
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut process = kcoder_test_harness::OwnedProcess::spawn_inherit_environment(command).ok()?;
    let stdout = process.take_stdout()?;
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(limit as u64 + 1).read_to_end(&mut bytes);
        let _ = send.send(result.map(|_| bytes));
    });
    let deadline = Instant::now() + timeout;
    let bytes = match receive.recv_timeout(timeout) {
        Ok(Ok(bytes)) => bytes,
        _ => {
            let _ = process.terminate(Duration::from_millis(100));
            return None;
        }
    };
    if bytes.len() > limit {
        let _ = process.terminate(Duration::from_millis(100));
        return Some(Probe::Exceeded);
    }
    loop {
        match process.try_wait() {
            Ok(Some(status)) => return Some(Probe::Complete(status, bytes)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = process.terminate(Duration::from_millis(100));
                return None;
            }
        }
    }
}

fn head(root: &Path) -> Option<String> {
    let Probe::Complete(status, bytes) = probe(
        git(root).args(["rev-parse", "--verify", "HEAD"]),
        64,
        PROBE_TIMEOUT,
    )?
    else {
        return None;
    };
    if !status.success() {
        return None;
    }
    let value = String::from_utf8(bytes).ok()?.trim().to_owned();
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(value.to_ascii_lowercase())
}

/// Observe HEAD and whether tracked or non-ignored untracked files changed.
/// Only a boolean is retained; file names and contents never enter the manifest.
pub(crate) fn capture(root: &Path) -> Option<SourceSnapshot> {
    let before = head(root)?;
    let clean = match probe(
        git(root).args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
        0,
        PROBE_TIMEOUT,
    )? {
        Probe::Complete(status, _) if status.success() => true,
        Probe::Exceeded => false,
        Probe::Complete(_, _) => return None,
    };
    if head(root)? != before {
        return None;
    }
    Some(SourceSnapshot {
        git_commit: before,
        clean,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run(root: &Path, args: &[&str]) {
        let status = git(root)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn observes_clean_tracked_and_untracked_source_without_recording_paths() {
        let temp = tempfile::tempdir().unwrap();
        run(temp.path(), &["init", "-q"]);
        fs::write(temp.path().join("source.txt"), b"original").unwrap();
        fs::write(temp.path().join(".gitignore"), b"ignored.tmp\n").unwrap();
        run(temp.path(), &["add", "source.txt", ".gitignore"]);
        run(
            temp.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "initial",
            ],
        );
        let original = capture(temp.path()).unwrap();
        assert!(original.clean);
        fs::write(temp.path().join("ignored.tmp"), b"ignored").unwrap();
        assert_eq!(capture(temp.path()).unwrap(), original);
        fs::write(temp.path().join("source.txt"), b"changed").unwrap();
        assert!(!capture(temp.path()).unwrap().clean);
        fs::write(temp.path().join("source.txt"), b"original").unwrap();
        fs::write(temp.path().join("untracked.txt"), b"new").unwrap();
        assert!(!capture(temp.path()).unwrap().clean);
    }

    #[test]
    fn unavailable_git_repository_is_not_reported_as_clean() {
        let temp = tempfile::tempdir().unwrap();
        assert!(capture(temp.path()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn hung_probe_is_stopped_without_claiming_source_state() {
        let started = Instant::now();
        let mut command = Command::new("sleep");
        command.arg("30");
        assert!(probe(&mut command, 0, Duration::from_millis(100)).is_none());
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}

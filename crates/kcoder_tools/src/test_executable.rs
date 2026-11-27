//! Test fixtures that the test process itself later executes.
//!
//! Writing an executable with `std::fs::write` and then spawning it races with
//! every other test thread that forks: a child forked while the write handle
//! is open keeps a duplicate until it execs, and exec of a file that is still
//! open for writing fails with ETXTBSY ("Text file busy"). Writing through a
//! short-lived child process means no writable descriptor ever exists in the
//! test process, so concurrent forks cannot inherit one.

use std::path::Path;

/// Create `path` with `contents` and the given Unix permission `mode`.
pub(crate) fn write_executable(path: &Path, contents: impl AsRef<[u8]>, mode: u32) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut writer = Command::new("/bin/sh")
            .args([
                "-c",
                "umask 077 && cat > \"$1\" && chmod \"$2\" \"$1\"",
                "write-executable",
            ])
            .arg(path)
            .arg(format!("{mode:o}"))
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        writer
            .stdin
            .take()
            .unwrap()
            .write_all(contents.as_ref())
            .unwrap();
        assert!(writer.wait().unwrap().success(), "cannot write {path:?}");
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        std::fs::write(path, contents).unwrap();
    }
}

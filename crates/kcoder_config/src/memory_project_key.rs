//! Project partition keys shared by Memory and self-evolution storage.
//!
//! The key is derived from the Git root (or the canonical working directory)
//! as a sanitized path plus a 64-bit FNV-1a suffix. Memory directories and
//! evolution project partitions must use the same rule, so it lives here
//! rather than in either consumer. The output format is persisted in
//! directory names and must not change.
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::Duration;

/// Git root of `cwd`, falling back to its canonical path (or the path itself).
pub fn project_root_for_path(cwd: impl AsRef<Path>) -> PathBuf {
    git_root(cwd.as_ref())
        .or_else(|_| cwd.as_ref().canonicalize())
        .unwrap_or_else(|_| cwd.as_ref().to_path_buf())
}

/// Current Memory/evolution project partition key for a working directory.
pub fn project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = project_root_for_path(cwd);
    project_key(&root)
}

/// The pre-hash key format for a path, used only for one-time migrations of
/// stores written before keys gained a hash suffix.
pub fn legacy_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = project_root_for_path(cwd);
    legacy_project_key(&root)
}

/// The preceding sanitized-path plus 32-bit hash format, retained only for
/// one-time migration after project keys moved to a 64-bit suffix.
pub fn previous_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = project_root_for_path(cwd);
    previous_project_key(&root)
}

fn project_key(root: &Path) -> String {
    let abs = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let s = abs.to_string_lossy();
    let mut sanitized = sanitize_project_path(&s);
    // Keep each component below native byte and UTF-16 limits without changing
    // the full-path identity or splitting a UTF-8 scalar.
    if sanitized.len() > 200 {
        let mut end = 200;
        while !sanitized.is_char_boundary(end) {
            end -= 1;
        }
        sanitized.truncate(end);
    }
    // The sanitized form folds distinct paths together ("/foo bar" and
    // "/foo/bar" both become "_foo_bar"); a stable hash suffix keeps project
    // stores separate.
    format!("{}-{:016x}", sanitized, fnv1a_64(s.as_bytes()))
}

/// The unbounded 64-bit key format, retained only for one-time migration
/// after long keys gained a length bound.
pub fn unbounded_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = project_root_for_path(cwd);
    let text = root.to_string_lossy();
    format!(
        "{}-{:016x}",
        sanitize_project_path(&text),
        fnv1a_64(text.as_bytes())
    )
}

fn previous_project_key(root: &Path) -> String {
    let abs = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let s = abs.to_string_lossy();
    let sanitized = sanitize_project_path(&s);
    format!("{}-{:08x}", sanitized, fnv1a_32(s.as_bytes()))
}

fn legacy_project_key(root: &Path) -> String {
    let abs = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    sanitize_project_path(&abs.to_string_lossy())
}

fn sanitize_project_path(path: &str) -> String {
    path.chars()
        .map(|ch| {
            let invalid = matches!(ch, '/' | '\\' | ':' | ' ')
                || (cfg!(windows)
                    && (ch.is_control() || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*')));
            if invalid { '_' } else { ch }
        })
        .collect()
}

fn fnv1a_32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn git_root(cwd: &Path) -> Result<PathBuf> {
    let git_path = which::which("git").context("failed to locate git")?;
    git_root_with_program(cwd, &git_path)
}

fn git_root_with_program(cwd: &Path, git_path: &Path) -> Result<PathBuf> {
    let output = run_git_root_command(cwd, git_path).context("failed to run git")?;
    if !output.status.success() {
        anyhow::bail!("not a git repository");
    }
    let root = String::from_utf8(output.stdout)?;
    Ok(PathBuf::from(root.trim()))
}

fn run_git_root_command(cwd: &Path, git_path: &Path) -> std::io::Result<Output> {
    const EXECUTABLE_BUSY: i32 = 26;
    const MAX_ATTEMPTS: usize = 3;

    for attempt in 0..MAX_ATTEMPTS {
        match git_root_command(cwd, git_path).output() {
            Ok(output) => return Ok(output),
            Err(error)
                if error.raw_os_error() == Some(EXECUTABLE_BUSY) && attempt + 1 < MAX_ATTEMPTS =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }

    unreachable!("loop returns on success or final error")
}

fn git_root_command(cwd: &Path, git_path: &Path) -> Command {
    let mut command = Command::new(git_path);
    command
        .args(["rev-parse", "--show-toplevel"])
        .env_clear()
        .env("PWD", cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .current_dir(cwd);
    #[cfg(not(windows))]
    command
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("TERM", "xterm-256color");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // This Git query is non-interactive and must not create a console window.
        command.creation_flags(0x0800_0000);
        for name in [
            "SystemRoot",
            "WINDIR",
            "ComSpec",
            "PATHEXT",
            "PATH",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    command
}

#[cfg(test)]
#[path = "memory_project_key/tests.rs"]
mod tests;

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::Duration;

/// Global user memory file path.
///
/// Honours `KCODER_CONFIG_DIR` so isolated runs (containers, tests,
/// multi-account setups) never read or write the real user-level store.
pub fn global_memory_path() -> Result<PathBuf> {
    Ok(kcoder_config::user_config_dir()?.join("memories.json"))
}

#[cfg(test)]
fn global_memory_path_with_override(override_dir: Option<std::ffi::OsString>) -> Result<PathBuf> {
    let dir = override_dir
        .filter(|dir| !dir.is_empty())
        .ok_or_else(|| anyhow::anyhow!("config directory override was empty"))?;
    Ok(PathBuf::from(dir).join("memories.json"))
}

/// Resolve a project memory directory from the current working directory.
///
/// Uses the git root when available, otherwise the canonicalized cwd.
pub fn project_memory_dir(cwd: impl AsRef<Path>, base: impl AsRef<Path>) -> Result<PathBuf> {
    let key = project_key_for_path(cwd.as_ref());
    let dir = base.as_ref().join("projects").join(&key).join("memory");
    if !dir.exists() {
        // Migrate the immediately preceding 32-bit key first, then the
        // original unhashed key. Propagate failures so callers never switch
        // to an empty new directory while the old store remains stranded.
        for old_key in [
            previous_project_key_for_path(cwd.as_ref()),
            legacy_project_key_for_path(cwd.as_ref()),
        ] {
            let old_dir = base.as_ref().join("projects").join(old_key).join("memory");
            if !old_dir.exists() {
                continue;
            }
            if let Some(parent) = dir.parent() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!(
                        "failed to create project memory migration directory {}",
                        parent.display()
                    )
                })?;
                std::fs::rename(&old_dir, &dir).with_context(|| {
                    format!(
                        "failed to migrate legacy project memory from {} to {}",
                        old_dir.display(),
                        dir.display()
                    )
                })?;
            }
            break;
        }
    }
    Ok(dir)
}

pub fn project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = git_root(cwd.as_ref())
        .or_else(|_| cwd.as_ref().canonicalize())
        .unwrap_or_else(|_| cwd.as_ref().to_path_buf());
    project_key(&root)
}

/// The pre-hash key format for a path, used only for one-time migrations of
/// stores written before keys gained a hash suffix.
pub fn legacy_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = git_root(cwd.as_ref())
        .or_else(|_| cwd.as_ref().canonicalize())
        .unwrap_or_else(|_| cwd.as_ref().to_path_buf());
    legacy_project_key(&root)
}

/// The preceding sanitized-path plus 32-bit hash format, retained only for
/// one-time migration after project keys moved to a 64-bit suffix.
pub fn previous_project_key_for_path(cwd: impl AsRef<Path>) -> String {
    let root = git_root(cwd.as_ref())
        .or_else(|_| cwd.as_ref().canonicalize())
        .unwrap_or_else(|_| cwd.as_ref().to_path_buf());
    previous_project_key(&root)
}

fn project_key(root: &Path) -> String {
    let abs = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let s = abs.to_string_lossy();
    let sanitized = sanitize_project_path(&s);
    // The sanitized form folds distinct paths together ("/foo bar" and
    // "/foo/bar" both become "_foo_bar"); a stable hash suffix keeps project
    // stores separate.
    format!("{}-{:016x}", sanitized, fnv1a_64(s.as_bytes()))
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
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn project_key_normalizes_path() {
        let key = project_key(Path::new("/foo bar/baz"));
        assert!(key.starts_with("_foo_bar_baz-"), "unexpected key: {key}");
        assert_eq!(key.rsplit_once('-').unwrap().1.len(), 16);
    }

    #[test]
    fn project_key_does_not_fold_distinct_paths_together() {
        let with_space = project_key(Path::new("/foo bar/baz"));
        let nested = project_key(Path::new("/foo/bar/baz"));
        assert_ne!(
            with_space, nested,
            "paths that sanitize to the same form must not share a key"
        );
    }

    #[cfg(windows)]
    #[test]
    fn project_keys_are_valid_windows_filename_components() {
        for key in [
            project_key(Path::new(r"\\?\C:\work\project")),
            previous_project_key(Path::new(r"\\?\C:\work\project")),
            legacy_project_key(Path::new(r"\\?\C:\work\project")),
        ] {
            assert!(
                !key.chars().any(|ch| ch.is_control()
                    || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')),
                "{key}"
            );
        }
    }

    #[test]
    fn project_memory_dir_migrates_legacy_unhashed_store() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let cwd = tmp.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        // Write a store under the pre-hash key format.
        let legacy_dir = base
            .join("projects")
            .join(legacy_project_key_for_path(&cwd))
            .join("memory");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("note.md"), "legacy").unwrap();

        let dir = project_memory_dir(&cwd, &base).unwrap();

        assert!(
            dir.join("note.md").exists(),
            "legacy store must be migrated, not orphaned"
        );
        assert!(
            !legacy_dir.exists(),
            "legacy directory must be moved, not copied"
        );
    }

    #[test]
    fn project_memory_dir_migrates_previous_32_bit_key_store() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let cwd = tmp.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let previous_dir = base
            .join("projects")
            .join(previous_project_key_for_path(&cwd))
            .join("memory");
        std::fs::create_dir_all(&previous_dir).unwrap();
        std::fs::write(previous_dir.join("note.md"), "previous").unwrap();

        let dir = project_memory_dir(&cwd, &base).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("note.md")).unwrap(),
            "previous"
        );
        assert!(!previous_dir.exists());
    }

    #[test]
    fn project_memory_dir_reports_legacy_migration_failure() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let cwd = tmp.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let legacy_dir = base
            .join("projects")
            .join(legacy_project_key_for_path(&cwd))
            .join("memory");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("note.md"), "legacy").unwrap();

        let destination_project = base.join("projects").join(project_key_for_path(&cwd));
        std::fs::create_dir_all(destination_project.parent().unwrap()).unwrap();
        std::fs::write(&destination_project, "blocks destination directory").unwrap();

        let error = project_memory_dir(&cwd, &base).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("failed to create project memory migration directory"),
            "{error:#}"
        );
        assert!(legacy_dir.join("note.md").exists());
    }

    #[test]
    fn project_memory_dir_under_base() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let dir = project_memory_dir(tmp.path(), &base).unwrap();
        assert!(dir.starts_with(&base));
        assert!(dir.to_string_lossy().contains("memory"));
    }

    #[cfg(unix)]
    #[test]
    fn git_root_uses_clean_environment() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let fake_git = tmp.path().join("git");
        std::fs::write(
            &fake_git,
            "#!/bin/sh\nif [ \"${HOME-unset}\" != \"unset\" ]; then exit 2; fi\nif [ \"$GIT_TERMINAL_PROMPT\" != \"0\" ]; then exit 3; fi\nif [ \"${GIT_ASKPASS-unset}\" != \"\" ]; then exit 4; fi\nprintf '%s\\n' \"$PWD\"\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_git).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_git, permissions).unwrap();

        let root = git_root_with_program(tmp.path(), &fake_git).unwrap();

        assert_eq!(root, tmp.path());
    }

    #[cfg(windows)]
    #[test]
    fn git_root_keeps_required_windows_runtime_environment() {
        let tmp = TempDir::new().unwrap();
        let fake_git = tmp.path().join("git.cmd");
        let capture = tmp.path().join("git-environment.txt");
        let escaped_capture = capture.display().to_string().replace('%', "%%");
        std::fs::write(
            &fake_git,
            format!(
                "@echo off\r\n> \"{escaped_capture}\" echo root=%SystemRoot%\r\n>> \"{escaped_capture}\" echo path=%PATH%\r\n>> \"{escaped_capture}\" echo user=%USERPROFILE%\r\necho %CD%\r\n"
            ),
        )
        .unwrap();

        let root = git_root_with_program(tmp.path(), &fake_git).unwrap();
        let environment = std::fs::read_to_string(capture).unwrap();

        assert_eq!(root, tmp.path());
        assert!(
            environment.contains(&format!("root={}", std::env::var("SystemRoot").unwrap())),
            "{environment}"
        );
        assert!(
            environment.contains(&format!("path={}", std::env::var("PATH").unwrap())),
            "{environment}"
        );
        assert!(
            environment.contains(&format!("user={}", std::env::var("USERPROFILE").unwrap())),
            "{environment}"
        );
    }

    #[test]
    fn project_key_uses_git_root_for_unicode_repository_path() {
        if which::which("git").is_err() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("仓库 昆仑");
        let nested = root.join("子目录 你好");
        std::fs::create_dir_all(&nested).unwrap();
        let status = Command::new("git")
            .arg("init")
            .arg(&root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        assert_eq!(project_key_for_path(&nested), project_key_for_path(&root));
        assert!(project_key_for_path(&nested).contains("仓库_昆仑"));
    }

    #[test]
    fn global_memory_path_honours_config_dir_env() {
        let tmp = TempDir::new().unwrap();
        let resolved =
            global_memory_path_with_override(Some(tmp.path().as_os_str().to_owned())).unwrap();
        assert_eq!(resolved, tmp.path().join("memories.json"));
    }
}

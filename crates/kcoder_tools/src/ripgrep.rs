//! ripgrep resolution contract.
//!
//! Runtime resolution prefers a user-specified path and system `rg`, then searches
//! for a platform-specific bundled copy. No platform binary is embedded directly in
//! the Rust crate; release scripts place the target's `rg` in a resource directory beside the executable.

use std::env;
#[cfg(unix)]
use std::fs;
use std::path::{Path, PathBuf};

/// Allow installers and tests to specify ripgrep explicitly.
const OVERRIDE_ENV_VARS: &[&str] = &["KCODER_RIPGREP_PATH", "KCODER_RG_PATH"];

/// Locate an executable ripgrep.
///
/// Resolution order: explicit override, system executable on PATH, then bundled resource.
pub(crate) fn find_ripgrep() -> Option<PathBuf> {
    for variable in OVERRIDE_ENV_VARS {
        if let Ok(value) = env::var(variable)
            && let Some(path) = usable_path(Path::new(&value))
        {
            return Some(path);
        }
    }

    let command = if cfg!(windows) { "rg.exe" } else { "rg" };
    if let Ok(path) = which::which(command) {
        return Some(path);
    }

    for path in bundled_candidates() {
        if let Some(path) = usable_path(&path) {
            return Some(path);
        }
    }
    None
}

fn bundled_candidates() -> Vec<PathBuf> {
    let Some(executable) = env::current_exe().ok() else {
        return Vec::new();
    };
    let Some(bin_dir) = executable.parent() else {
        return Vec::new();
    };
    let rg_name = if cfg!(windows) { "rg.exe" } else { "rg" };

    // Support release archives, user-level installs, and server /usr/local/bin layouts.
    let mut candidates = vec![
        bin_dir.join(rg_name),
        bin_dir.join("libexec").join(rg_name),
        bin_dir.join("resources").join(rg_name),
        bin_dir.join("..").join("lib").join("kcoder").join(rg_name),
    ];
    if let Some(prefix) = bin_dir.parent() {
        candidates.extend([
            prefix.join("lib").join("kcoder").join(rg_name),
            prefix.join("libexec").join("kcoder").join(rg_name),
            prefix.join("resources").join(rg_name),
        ]);
    }
    candidates
}

fn usable_path(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path).ok()?.permissions().mode();
        if mode & 0o111 == 0 {
            return None;
        }
    }
    Some(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_candidates_include_install_layout() {
        let candidates = bundled_candidates();
        assert!(candidates.iter().any(|path| {
            path.to_string_lossy().contains("lib") && path.to_string_lossy().contains("kcoder")
        }));
    }

    #[test]
    fn unusable_path_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(usable_path(&tmp.path().join("missing-rg")).is_none());
    }
}

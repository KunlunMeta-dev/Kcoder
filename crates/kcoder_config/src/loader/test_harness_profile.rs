//! Keep cargo test processes out of the developer's real profile.
//!
//! In-process tests construct engines, cron stores, shell snapshots and other
//! services that resolve the user configuration directory. Without an explicit
//! `KCODER_CONFIG_DIR`/`KCODER_HOME`, a libtest harness would resolve
//! `$HOME/.config/kcoder` and leave state in the personal profile. A harness
//! instead gets a private per-process profile below the cargo target
//! directory, which holds generated outputs only.
//!
//! Detection is structural: libtest executables live in `<target>/<profile>/deps`
//! and are named `<crate>-<16 hex digits>`. Installed and released binaries are
//! never laid out that way, and binaries that tests spawn (`target/debug/kcoder`)
//! do not match either, so their resolution is unchanged.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const PROFILES_DIR: &str = "test-profiles";

/// The private profile for this process, when it is a cargo test harness.
pub(super) fn test_harness_profile() -> Option<PathBuf> {
    static PROFILE: OnceLock<Option<PathBuf>> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let executable = std::env::current_exe().ok()?;
            let (profiles, stem) = harness_layout(&executable)?;
            match create_process_profile(&profiles, &stem, std::process::id()) {
                Ok(profile) => Some(profile),
                Err(error) => {
                    // Never fall back to the personal profile silently.
                    panic!(
                        "cannot create the isolated test profile under {}: {error}",
                        profiles.display()
                    )
                }
            }
        })
        .clone()
}

/// Return `(<target>/<profile>/test-profiles, <harness stem>)` for a libtest
/// executable path, or `None` for any other executable.
pub(super) fn harness_layout(executable: &Path) -> Option<(PathBuf, String)> {
    let deps = executable.parent()?;
    if deps.file_name()? != "deps" {
        return None;
    }
    let stem = executable.file_stem()?.to_str()?;
    let (name, hash) = stem.rsplit_once('-')?;
    let is_hash = hash.len() == 16
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if name.is_empty() || !is_hash {
        return None;
    }
    Some((deps.parent()?.join(PROFILES_DIR), stem.to_string()))
}

fn create_process_profile(profiles: &Path, stem: &str, pid: u32) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(profiles)?;
    remove_profiles_of_exited_processes(profiles, stem, pid);
    let profile = profiles.join(format!("{stem}-{pid}"));
    // A directory with this name can only belong to an exited process whose
    // PID was reused, never to a live peer.
    match std::fs::remove_dir_all(&profile) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&profile)?;
    Ok(profile)
}

/// Reclaim profiles left by earlier runs of the same harness whose process has
/// exited. Liveness is only observable through `/proc`; elsewhere old profiles
/// stay until the target directory is cleaned.
fn remove_profiles_of_exited_processes(profiles: &Path, stem: &str, current: u32) {
    if !Path::new("/proc/self").exists() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(profiles) else {
        return;
    };
    let prefix = format!("{stem}-");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.strip_prefix(&prefix))
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != current && !Path::new("/proc").join(pid.to_string()).exists() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_libtest_harness_paths_are_recognized() {
        let target = Path::new("/work/target/debug");
        assert_eq!(
            harness_layout(&target.join("deps/kcoder_engine-61a1dfb9558a0f6c")),
            Some((
                target.join(PROFILES_DIR),
                "kcoder_engine-61a1dfb9558a0f6c".to_string()
            ))
        );
        assert_eq!(
            harness_layout(&target.join("deps/kcoder-e8c53a3bcdc48b37.exe")).map(|(_, stem)| stem),
            Some("kcoder-e8c53a3bcdc48b37".to_string())
        );
        for other in [
            target.join("kcoder"),
            target.join("kcoder-dev"),
            PathBuf::from("/usr/local/bin/kcoder"),
            target.join("deps/kcoder"),
            target.join("deps/kcoder-61A1DFB9558A0F6C"),
            target.join("deps/kcoder-61a1dfb9558a0f6"),
            target.join("deps/-61a1dfb9558a0f6c"),
            PathBuf::from("/opt/kcoder/bin/kcoder-61a1dfb9558a0f6c"),
        ] {
            assert_eq!(harness_layout(&other), None, "{}", other.display());
        }
    }

    #[test]
    fn this_harness_uses_a_private_profile_outside_home() {
        let profile = test_harness_profile().expect("cargo test runs a libtest harness");
        assert!(profile.is_dir());
        assert_eq!(
            profile.parent().and_then(Path::file_name),
            Some(std::ffi::OsStr::new(PROFILES_DIR))
        );
        if let Some(home) = dirs::home_dir() {
            assert!(!profile.starts_with(home.join(".config")));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&profile).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[test]
    fn profiles_of_exited_processes_are_reclaimed_and_live_ones_kept() {
        let profiles = tempfile::tempdir().unwrap();
        let stem = "fixture-0123456789abcdef";
        let live = std::process::id();
        let exited = u32::MAX - 1;
        std::fs::create_dir(profiles.path().join(format!("{stem}-{exited}"))).unwrap();
        std::fs::create_dir(profiles.path().join("other-0123456789abcdef-1")).unwrap();
        let created = create_process_profile(profiles.path(), stem, live).unwrap();
        assert!(created.is_dir());
        if Path::new("/proc/self").exists() {
            assert!(!profiles.path().join(format!("{stem}-{exited}")).exists());
        }
        assert!(profiles.path().join("other-0123456789abcdef-1").exists());
    }
}
